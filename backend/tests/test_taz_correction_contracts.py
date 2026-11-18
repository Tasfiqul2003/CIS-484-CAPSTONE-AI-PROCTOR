"""Synthetic HTTP/provider/security contracts. No service or devices are started."""
import asyncio
import io
import json
import wave
from uuid import UUID
from types import SimpleNamespace
import httpx
import pytest
from fastapi import HTTPException, FastAPI
from fastapi.testclient import TestClient
from backend.app import avatar_bridge, exam_speech
from backend.app.avatar_speech_provider import AvatarSynthesis, AvatarTranscription
from backend.app.speech_adapters import SpeechContext, SpeechOutputRequest, TranscriptionRequest, SpeechService, SpeechError
from backend.app.db import get_db

CONTEXT=SpeechContext(UUID(int=1),UUID(int=2),'revision',UUID(int=3))


def wav():
    output=io.BytesIO()
    with wave.open(output,'wb') as stream:
        stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(16000);stream.writeframes(b'\x01\x00'*1600)
    return output.getvalue()


@pytest.mark.parametrize('status,available',[(200,True),(401,False),(503,False)])
def test_linux_readiness_is_verified_not_just_configured(monkeypatch,status,available):
    def get(url,**kwargs):
        assert kwargs['headers']=={'X-Avatar-Token':'synthetic'}
        return httpx.Response(status,json={'synthesis':True,'transcription':True},request=httpx.Request('GET',url))
    monkeypatch.setattr(httpx,'get',get)
    assert AvatarSynthesis('http://speech.internal:8103','synthetic').status().available is available
    assert AvatarTranscription('http://speech.internal:8103','synthetic').status().available is available


def test_linux_adapter_keeps_pcm_and_transcription_contracts(monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request)
        assert request.headers['x-avatar-token']=='synthetic'
        if request.url.path.endswith('synthesize'):
            assert json.loads(request.content)['text']=='Approved question'
            return httpx.Response(200,content=wav(),headers={'Content-Type':'audio/wav'})
        return httpx.Response(200,json={'text':'Synthetic answer'})
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    synthesis=AvatarSynthesis('http://speech.internal:8103','synthetic')
    transcription=AvatarTranscription('http://speech.internal:8103','synthetic')
    assert asyncio.run(synthesis.synthesize(SpeechOutputRequest(CONTEXT,'Approved question'))).audio==wav()
    assert asyncio.run(transcription.transcribe(TranscriptionRequest(CONTEXT,wav(),'audio/wav'))) == 'Synthetic answer'
    assert len(calls)==2


@pytest.mark.parametrize('url',['file:///private','http://user:secret@host','http://host?token=secret',''])
def test_provider_rejects_ambiguous_or_credential_urls(url):
    with pytest.raises(ValueError):AvatarSynthesis(url,'synthetic')


def test_unconfigured_linux_provider_is_truthfully_unavailable(monkeypatch):
    monkeypatch.setenv('CYBROS_SPEECH_PROVIDER','avatar-service')
    monkeypatch.delenv('CYBROS_SPEECH_SERVICE_URL',raising=False)
    monkeypatch.delenv('CYBROS_SPEECH_SERVICE_TOKEN',raising=False)
    result=exam_speech.get_speech_service().capabilities()
    assert not result['synthesis']['available'] and not result['transcription']['available']


def test_assistance_delivery_loads_saved_operation_not_client_text(monkeypatch):
    from backend.app import avatar_assistance
    operation={'status':'succeeded','interaction_id':str(CONTEXT.interaction_id),'sequence_num':1,
        'action':'clarification','response':{'text':'Approved clarification'}}
    monkeypatch.setattr(avatar_assistance,'_request',lambda *args:operation)
    body=exam_speech.OralUtterance(sequence_num=1,request_id=UUID(int=4),kind='assistance',assistance_operation_id=UUID(int=5))
    pending={'id':CONTEXT.interaction_id,'question_text':'Approved question'}
    assert exam_speech.delivery_text(None,'session',body,pending)=='Approved clarification'
    operation['interaction_id']=str(UUID(int=9))
    with pytest.raises(HTTPException):exam_speech.delivery_text(None,'session',body,pending)


def test_avatar_media_requires_narrow_valid_capability_and_live_profile(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET_KEY','synthetic-correction-secret-at-least-32-characters')
    monkeypatch.setattr(avatar_bridge,'SERVICE_URL','http://avatar.internal')
    monkeypatch.setattr(avatar_bridge,'SERVICE_TOKEN','synthetic')
    row={'status':'in_progress','examiner_profile_snapshot':{'id':'prof-a'}}
    class DB:
        def execute(self,*args):return SimpleNamespace(mappings=lambda:SimpleNamespace(first=lambda:row))
    app=FastAPI();app.include_router(avatar_bridge.router)
    app.dependency_overrides[get_db]=lambda:DB()
    with TestClient(app) as client:
        assert client.get('/avatar/media/clip.mp4').status_code==404
        path=avatar_bridge._media_url('clip.mp4','prof-b',session_id=str(UUID(int=1))).removeprefix('/api')
        assert client.get(path).status_code==404
        path=avatar_bridge._media_url('other.mp4','prof-a',session_id=str(UUID(int=1))).removeprefix('/api').replace('other.mp4?','clip.mp4?')
        assert client.get(path).status_code==404
        row['status']='flagged'
        path=avatar_bridge._media_url('clip.mp4','prof-a',session_id=str(UUID(int=1))).removeprefix('/api')
        assert client.get(path).status_code==404


def test_avatar_service_reserves_profile_through_all_segments_and_rejects_foreign(monkeypatch):
    # Execute the real service route with synthetic renderer functions. This avoids
    # importing optional CUDA/Chatterbox modules; no actual avatar startup is claimed.
    import ast
    import threading
    import time
    from pathlib import Path
    from fastapi.responses import StreamingResponse
    source=Path(__file__).parents[2]/'avatar/avatar_app.py'
    tree=ast.parse(source.read_text(encoding='utf-8'))
    function=next(node for node in tree.body if isinstance(node,ast.AsyncFunctionDef) and node.name=='service_speak')
    function.decorator_list=[]
    lock=threading.Lock();active={'id':'prof-a'}
    def clips(sentence):
        assert lock.locked() and active['id']=='prof-a'
        return {'url':'/media/clip.mp4','text':sentence,'audio_s':1}
    def ndjson(events):
        for event in events:yield json.dumps(event)+'\n'
    namespace={'Request':object,'service_ok':lambda request:True,'bad':lambda message,status=400:SimpleNamespace(status_code=status),
        'split_sentences':lambda text:[text],'MAX_SPEAK_CHARS':8000,'avatar_ready':lambda:True,
        'StreamingResponse':StreamingResponse,'PREP_LOCK':lock,'ACTIVE':active,'LIVE':{'speaking':0},
        'clip_for':clips,'ndjson':ndjson,'time':time,'re':__import__('re')}
    exec(compile(ast.Module(body=[function],type_ignores=[]),str(source),'exec'),namespace)
    class Request:
        def __init__(self,profile):self.profile=profile
        async def json(self):return {'segments':['First?','Second?'],'profile':self.profile}
    async def run():
        response=await namespace['service_speak'](Request('prof-a'))
        iterator=response.body_iterator
        first=await anext(iterator)
        assert json.loads(first)['profile']=='prof-a'
        switched=threading.Event()
        def switch():
            with lock:active['id']='prof-b';switched.set()
        worker=threading.Thread(target=switch);worker.start()
        assert not switched.wait(.02)
        second=await anext(iterator)
        assert json.loads(second)['profile']=='prof-a'
        try:await anext(iterator)
        except StopAsyncIteration:pass
        worker.join(1);assert switched.is_set()
        wrong=await namespace['service_speak'](Request('prof-a'))
        event=json.loads(await anext(wrong.body_iterator))
        assert event['type']=='error'
        await wrong.body_iterator.aclose()
        assert not lock.locked() and namespace['LIVE']['speaking']==0
    asyncio.run(run())


@pytest.mark.parametrize('rubric',[
    {'rubric_type':'qualitative','criteria':[{'name':'X','max_score':5}]},
    {'criteria':[{'name':'X','max_score':5,'levels':['good','bad']}]},
    {'criteria':[{'name':'X','max_score':5,'min_score':False}]},
    {'aggregation':'weighted','criteria':[{'name':'X','max_score':5}]},
])
def test_unsupported_rubric_semantics_cannot_hide_in_extra_fields(rubric):
    from backend.app.assessment_contracts import rubric_criteria
    with pytest.raises(HTTPException):rubric_criteria(rubric)
