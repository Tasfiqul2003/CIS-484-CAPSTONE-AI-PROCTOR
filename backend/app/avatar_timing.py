"""SQL fragments for bounded, persisted assistance pauses (internal expressions only)."""


def pause_sum_sql(session_expression, interaction_expression=None):
    question = (f" AND ap.interaction_id = {interaction_expression}"
                if interaction_expression is not None else "")
    return f"""COALESCE((SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM
        (LEAST(COALESCE(ap.pause_ended_at, clock_timestamp()), ap.pause_until)
         - ap.pause_started_at)))) FROM avatar_assistance_requests ap
        WHERE ap.session_id = {session_expression} AND ap.pause_started_at IS NOT NULL
        AND (ap.status = 'succeeded' OR
             (ap.status = 'reserved' AND ap.created_at > clock_timestamp() - INTERVAL '120 seconds'))
        {question}), 0)"""


def active_pause_until_sql(session_expression):
    return f"""(SELECT MAX(ap.pause_until) FROM avatar_assistance_requests ap
        WHERE ap.session_id = {session_expression} AND ap.pause_started_at IS NOT NULL
          AND ap.pause_ended_at IS NULL AND ap.pause_until > clock_timestamp())"""
