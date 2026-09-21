"""Local, standard-library-only examiner experiment; not an authenticated exam service."""
import argparse, datetime, hashlib, json, math, pathlib, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
URL = 'http://127.0.0.1:11434'

def api(path, data=None, timeout=180):
    request = urllib.request.Request(URL + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)

def policy():
    return (ROOT/'ollama/Modelfile-v2.1').read_text().split('"""')[1].strip()

def messages(case):
    professor = case['professor']
    if professor.get('mode') not in ('assessment','practice'):
        raise ValueError('Professor must select assessment or practice')
    return [{'role':'system','content':policy()+'\nTRUSTED PROFESSOR CONFIGURATION:\n'+json.dumps(professor)},
            {'role':'user','content':json.dumps({'student_answer':case['student_answer']})}]

def student_view(professor, report):
    # Fail closed in assessment: no model-generated feedback or hints are released.
    # A professor can review the proposed follow-up separately before delivery.
    if professor.get('mode') == 'practice':
        return {'feedback':report.get('professor_feedback',''),'follow_up':report.get('follow_up')}
    return {'message':'Response recorded for professor review.'}

def checks(report, expected, student):
    errors=[]
    for key in ('status','score','max_points'):
        if report.get(key) != expected[key]: errors.append(f'{key}: expected {expected[key]!r}, got {report.get(key)!r}')
    criteria=report.get('criteria')
    if not isinstance(criteria,list) or not criteria:
        errors.append('Missing criteria'); criteria=[]
    for c in criteria:
        if not isinstance(c,dict): errors.append('Criterion is not an object'); continue
        if not all(k in c for k in ('id','judgment','evidence','points','justification')): errors.append('Incomplete criterion')
        evidence=c.get('evidence','')
        if not isinstance(evidence,str) or (evidence and evidence not in student): errors.append('Evidence is not an exact student quote')
    if 'judgments' in expected and [c.get('judgment') for c in criteria if isinstance(c,dict)] != expected['judgments']:
        errors.append('Unexpected qualitative judgments')
    score=report.get('score')
    if score is not None:
        points=[c.get('points') for c in criteria if isinstance(c,dict)]
        numeric=lambda x: type(x) in (int,float) and math.isfinite(x)
        if not numeric(score) or not all(numeric(x) and x>=0 for x in points) or not math.isclose(sum(points),score): errors.append('Invalid score arithmetic')
        maximum=report.get('max_points')
        if not numeric(maximum) or not numeric(score) or not 0<=score<=maximum: errors.append('Score outside range')
    if report.get('status')=='needs_professor_clarification' and not report.get('ambiguities'): errors.append('Missing ambiguity explanation')
    if report.get('status')=='needs_student_clarification' and not report.get('follow_up'): errors.append('Missing clarification question')
    for key in ('rubric_type','ambiguities','professor_feedback','follow_up'):
        if key not in report: errors.append('Missing '+key)
    return errors

def run(args):
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    out=ROOT/'tests/results'/stamp; out.mkdir(parents=True)
    cases=json.loads((ROOT/'tests/cases.json').read_text())
    expected=json.loads((ROOT/'tests/expected.json').read_text())
    if args.case: cases=[c for c in cases if c['id'] in args.case]
    if not cases: raise ValueError('No matching cases')
    metadata={'utc':stamp,'model':args.model,'seed':args.seed,'think':False,'options':{'temperature':0.4,'top_p':0.85,'num_ctx':16384,'seed':args.seed,'num_predict':1800},'files':{f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in ['ollama/Modelfile-v2.1','tests/cases.json','tests/expected.json','tests/run_rubrics.py']}}
    rows=[]
    try:
        metadata['version']=api('/api/version'); metadata['models']=api('/api/tags')
        metadata['model_info']=api('/api/show',{'model':args.model})
        available=True
    except Exception as e:
        metadata['environment_error']=str(e); available=False
    (out/'environment.json').write_text(json.dumps(metadata,indent=2))
    for case in cases:
        row={'id':case['id'],'expected':expected[case['id']],'status':'blocked'}
        if available:
            payload={'model':args.model,'messages':messages(case),'format':'json','stream':False,'think':False,'options':metadata['options']}
            row['request']=payload
            try:
                raw=api('/api/chat',payload); row['raw_response']=raw
                if raw.get('done_reason')=='length': raise ValueError('Truncated model response')
                report=json.loads(raw['message']['content']); row['actual']=report
                row['errors']=checks(report,expected[case['id']],case['student_answer'])
                row['student_view']=student_view(case['professor'],report)
                row['status']='failed' if row['errors'] else 'passed'
            except Exception as e:
                row['error']=str(e); row['status']='error'
        else: row['error']=metadata['environment_error']
        (out/(case['id']+'.json')).write_text(json.dumps(row,indent=2))
        rows.append({'id':row['id'],'status':row['status'],'errors':row.get('errors',[]),'error':row.get('error')})
        print(case['id'],row['status'],flush=True)
    (out/'summary.json').write_text(json.dumps(rows,indent=2))
    print('Results:',out,flush=True)
    return 0 if all(r['status']=='passed' for r in rows) else 1

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',default='qwen3:4b',help='Existing local model; v2.1 system instructions are supplied explicitly')
    parser.add_argument('--seed',type=int,default=42)
    parser.add_argument('--case',action='append')
    raise SystemExit(run(parser.parse_args()))
