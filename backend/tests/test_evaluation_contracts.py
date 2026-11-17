import pytest
import json
from fastapi import HTTPException
from backend.app.evaluation_contracts import validate_evaluation, completed_evaluation, evaluation_output_schema

CRITERIA = [{'name': 'Accuracy', 'max_score': 10}]


def evaluation(**overrides):
    return {'scores': [{'criterion': 'Accuracy', 'score': 6, 'rationale': 'Synthetic evidence.', **overrides}]}


def test_valid_provisional_evaluation():
    assert validate_evaluation(evaluation(), CRITERIA)['accuracy']['score'] == 6


@pytest.mark.parametrize('result', [[], {}, {'scores': []}, evaluation(score=True),
    evaluation(score=-1), evaluation(score=11), evaluation(score=float('nan')),
    evaluation(score=float('inf')), evaluation(score='8'), evaluation(criterion='Invented'),
    {'scores': evaluation()['scores'] * 2}, evaluation(rationale={'private': 'structure'}),
    {**evaluation(), 'student_message': 'Private rubric leak'}])
def test_invalid_provider_output_does_not_become_a_grade(result):
    with pytest.raises(HTTPException) as error:
        validate_evaluation(result, CRITERIA)
    assert error.value.status_code == 502


def test_schema_requires_scores_and_approved_criteria_not_echoed_inputs():
    schema = evaluation_output_schema(CRITERIA)
    assert schema['required'] == ['scores'] and schema['additionalProperties'] is False
    scores = schema['properties']['scores']
    assert scores['minItems'] == scores['maxItems'] == 1
    assert scores['items']['required'] == ['criterion', 'score', 'rationale']
    assert scores['items']['properties']['criterion']['enum'] == ['Accuracy']
    assert scores['items']['properties']['score'] == {'type':'number','minimum':0,'maximum':10}


def test_completed_structured_score_preserves_strict_criterion_validation():
    envelope = {'done': True, 'done_reason': 'stop', 'message': {'content': json.dumps(evaluation())}}
    assert completed_evaluation(envelope, CRITERIA)['accuracy']['score'] == 6
    envelope['message']['content'] = json.dumps(evaluation(score=11))
    with pytest.raises(HTTPException) as error:
        completed_evaluation(envelope, CRITERIA)
    assert error.value.status_code == 502


@pytest.mark.parametrize('envelope', [
    {'done':True,'done_reason':'stop','message':{'content':json.dumps({'exam_title':'Synthetic','criteria':CRITERIA,'topics_required':[],'transcript':[]})}},
    {'done':True,'done_reason':'length','message':{'content':json.dumps(evaluation())}},
    {'done':False,'done_reason':'stop','message':{'content':json.dumps(evaluation())}},
    {'message':{'content':json.dumps(evaluation())}},
    {'done':True,'done_reason':'stop','message':{'content':'{"scores":['}},
    {'done':True,'done_reason':'stop','message':{'content':'x'*100001}},
    {'done':True,'done_reason':'stop','message':{'content':None}},
])
def test_incomplete_or_echoed_assessment_is_rejected_without_repair(envelope):
    with pytest.raises(HTTPException) as error:
        completed_evaluation(envelope, CRITERIA)
    assert error.value.status_code == 502 and 'No grades were saved' in error.value.detail
