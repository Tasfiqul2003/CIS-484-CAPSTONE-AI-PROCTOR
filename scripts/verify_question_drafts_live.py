"""Explicit local HTTP-only synthetic draft verification; never publish or use devices.

Run only after the operator has approved/started the local stack and applied the
reviewed migrations. Credentials stay in memory, read from the protected account
file; logs contain only stage/status/timing/counts and owned synthetic IDs.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from uuid import uuid4

import httpx


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "private-data/p3-local"
BASE = "http://127.0.0.1:5173/api"


class VerificationFailure(Exception):
    pass


def credentials(payload, name):
    candidates = payload.get("accounts", payload) if isinstance(payload, dict) else payload
    if isinstance(candidates, dict) and name in candidates:
        value = candidates[name]
        if isinstance(value, str):
            return {"username": name, "password": value}
        if isinstance(value, dict) and isinstance(value.get("password"), str):
            return {"username": value.get("username", name), "password": value["password"]}
    if isinstance(candidates, dict):
        for value in candidates.values():
            if isinstance(value, dict) and value.get("username") == name and isinstance(value.get("password"), str):
                return {"username": name, "password": value["password"]}
    if isinstance(candidates, list):
        for value in candidates:
            if isinstance(value, dict) and value.get("username") == name and isinstance(value.get("password"), str):
                return {"username": name, "password": value["password"]}
    raise VerificationFailure("Protected synthetic account is unavailable")


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-local-http", action="store_true", required=True,
                        help="Explicitly exercise the already-running local stack")
    parser.parse_args()
    directory = DATA / "verification"
    directory.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = directory / f"question-drafts-live-{stamp}.json"
    report = {"started_at": datetime.now(timezone.utc).isoformat(), "mode": "real_local_http_ollama_synthetic_exam",
              "stages": [], "exam_id": None, "cleanup": "not_needed", "success": False}

    def save():
        output.write_text(json.dumps(report, indent=2), encoding="utf-8")

    def call(client, method, path, *, expected=(200,), stage, **kwargs):
        started = time.monotonic()
        try:
            response = client.request(method, path, **kwargs)
        except httpx.HTTPError:
            report["stages"].append({"stage": stage, "transport": "failed", "seconds": round(time.monotonic()-started, 3)})
            save()
            raise VerificationFailure(f"{stage}: local transport failed") from None
        report["stages"].append({"stage": stage, "status": response.status_code, "seconds": round(time.monotonic()-started, 3)})
        save()
        if response.status_code not in expected:
            raise VerificationFailure(f"{stage}: HTTP {response.status_code}")
        if response.status_code in (204,404):
            return None
        try:
            return response.json()
        except ValueError:
            raise VerificationFailure(f"{stage}: invalid JSON response") from None

    def check(condition, message):
        if not condition:
            raise VerificationFailure(message)

    exam_id = None
    title = f"Synthetic draft verification {stamp}-{uuid4().hex[:8]}"
    try:
        accounts = json.loads((DATA / "local-accounts.json").read_text(encoding="utf-8-sig"))
        owner_credentials = credentials(accounts, "p3-professor")
        other_credentials = credentials(accounts, "p3-other-professor")
        # Do not inherit HTTP proxy settings or follow a redirect off localhost.
        with httpx.Client(base_url=BASE, timeout=130, trust_env=False, follow_redirects=False) as owner, \
             httpx.Client(base_url=BASE, timeout=30, trust_env=False, follow_redirects=False) as other:
            call(owner,"GET","/health/ready",stage="local_readiness")
            login = call(owner,"POST","/auth/login",json=owner_credentials,stage="owner_auth")
            check(login.get("role") == "professor", "Synthetic owner account is not a professor")
            login = call(other,"POST","/auth/login",json=other_credentials,stage="other_auth")
            check(login.get("role") == "professor", "Synthetic second account is not a professor")
            created = call(owner,"POST","/exam/templates",expected=(201,),stage="create_scratch_exam",
                json={"course":"SYNTH-VERIFY", "title":title, "description":"Generated synthetic verification only; never publish.", "icon":""})
            exam_id = created["id"]
            report["exam_id"] = exam_id
            report["cleanup"] = "pending"
            save()
            prefix = f"/exam/templates/{exam_id}"
            try:
                original = call(owner,"GET",f"{prefix}/question-drafts/context",stage="read_empty_context")
                configured = call(owner,"PUT",f"{prefix}/question-drafts/context",stage="configure_topics_rubric",json={
                    "expected_context_hash": original["context_hash"],
                    "topic_coverage_required":["Recursion"],
                    "rubric":{"criteria":[{"name":"Conceptual accuracy", "description":"Explain a base case and a recursive step using a simple example.", "max_score":5}]}})
                check(configured["topic_coverage_required"] == ["Recursion"], "Scratch topic configuration did not persist")
                bank = call(owner,"GET",f"{prefix}/questions",stage="bank_before_generation")
                check(len(bank) == 0, "New scratch bank was unexpectedly nonempty")
                request = {"request_id":str(uuid4()), "topic":"Recursion", "difficulty":2, "count":2}
                generated = call(owner,"POST",f"{prefix}/question-drafts/generate",json=request,stage="actual_ollama_generation")
                check(generated.get("status") == "ready" and len(generated.get("drafts",[])) == 2, "Actual model did not produce two ready drafts")
                drafts = generated["drafts"]
                report["generated_count"] = len(drafts)
                check(all(draft["status"] == "pending" for draft in drafts), "Generated content was not isolated as pending drafts")
                check(len(call(owner,"GET",f"{prefix}/questions",stage="bank_after_generation")) == 0, "Unapproved draft reached the bank")
                replay = call(owner,"POST",f"{prefix}/question-drafts/generate",json=request,stage="generation_retry")
                check({draft["id"] for draft in replay["drafts"]} == {draft["id"] for draft in drafts}, "Generation retry changed draft identities")
                call(other,"GET",f"{prefix}/question-drafts",expected=(404,),stage="wrong_professor_draft_list")
                edited = {"question_text":"Explain how a base case prevents infinite recursion in a simple recursive function.", "topic":"Recursion", "difficulty":2}
                approved = call(owner,"POST",f"{prefix}/question-drafts/{drafts[0]['id']}/approve",json=edited,stage="approve_reviewed_draft")
                repeat = call(owner,"POST",f"{prefix}/question-drafts/{drafts[0]['id']}/approve",json=edited,stage="approval_retry")
                check(approved["question_id"] == repeat["question_id"], "Approval retry duplicated the bank question")
                call(other,"POST",f"{prefix}/question-drafts/{drafts[1]['id']}/approve",json=edited,expected=(404,),stage="wrong_professor_approval")
                call(owner,"POST",f"{prefix}/question-drafts/{drafts[1]['id']}/reject",json={},stage="reject_second_draft")
                bank = call(owner,"GET",f"{prefix}/questions",stage="bank_only_approved")
                check(len(bank) == 1 and bank[0]["question_text"] == edited["question_text"], "Saved bank did not contain exactly the approved edited question")
                report["approved_bank_count"] = len(bank)
                exams = call(owner,"GET","/auth/professor/exams",stage="scratch_remains_unpublished")
                scratch = next((exam for exam in exams if exam["id"] == exam_id),None)
                check(scratch is not None and scratch["title"] == title and scratch["status"] == "draft", "Scratch ownership/title/publication verification failed")
                report["success"] = True
            finally:
                # Only delete the exact exam created by this run, after verifying
                # its unique synthetic title and unpublished state through API.
                try:
                    owned = call(owner,"GET","/auth/professor/exams",stage="cleanup_owner_check")
                    scratch = next((exam for exam in owned if exam["id"] == exam_id),None)
                    if scratch is not None and scratch["title"] == title and scratch["status"] == "draft":
                        call(owner,"DELETE",prefix,stage="cleanup_scratch_exam")
                        report["cleanup"] = "owned_scratch_exam_deleted"
                    else:
                        report["cleanup"] = "ownership_or_state_changed_manual_review_required"
                except Exception:
                    report["cleanup"] = "failed_manual_review_required"
                save()
    except Exception as error:
        report["success"] = False
        report["failure"] = str(error) if isinstance(error,VerificationFailure) else f"Unexpected {type(error).__name__}; private details suppressed"
    finally:
        if report["cleanup"] not in ("not_needed", "owned_scratch_exam_deleted"):
            report["success"] = False
            report.setdefault("failure", "Owned scratch cleanup requires review")
        report["completed_at"] = datetime.now(timezone.utc).isoformat()
        save()
        # This summary contains no credentials, cookies, model text or rubric.
        print(json.dumps({"success":report["success"],"cleanup":report["cleanup"],"report":str(output),
                          "failure":report.get("failure")}))
    return 0 if report["success"] and report["cleanup"] == "owned_scratch_exam_deleted" else 1


if __name__ == "__main__":
    raise SystemExit(run())
