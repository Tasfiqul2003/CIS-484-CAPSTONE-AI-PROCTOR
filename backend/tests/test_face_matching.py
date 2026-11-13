from backend.app.face_matching import face_check_decision, frame_set_matches


def test_sface_frame_set_requires_two_of_three_thresholds():
    assert frame_set_matches([0.4, 0.37, 0.1])
    assert not frame_set_matches([0.4, 0.2, 0.1])
    assert not frame_set_matches([0.9, 0.9])


def test_face_check_allows_a_match_without_professor_flag():
    result = face_check_decision(matched=True, attempts_so_far=0)

    assert result == {
        "attempt": 1,
        "allowed": True,
        "matched": True,
        "review_required": False,
        "status": "matched",
    }


def test_face_check_blocks_all_mismatches_and_requests_help_after_third():
    first = face_check_decision(matched=False, attempts_so_far=0)
    second = face_check_decision(matched=False, attempts_so_far=1)
    third = face_check_decision(matched=False, attempts_so_far=2)

    assert not first["allowed"] and not first["review_required"]
    assert not second["allowed"] and not second["review_required"]
    assert not third["allowed"] and third["review_required"]
    assert third["status"] == "no_match"
    assert third["attempt"] == 3
