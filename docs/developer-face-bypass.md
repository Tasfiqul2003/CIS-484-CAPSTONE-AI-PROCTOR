# Synthetic developer photo-check bypass

On P3, expand **About this check** on the Photo check page. The **Developer mode**
section contains a **Bypass** field. Enter one of these existing synthetic EIDs:

- `student.demo`
- `student.demo2`
- `student.demo3`
- `student.demo4` through `student.demo53` (50 additional synthetic students, explicitly approved November17)

Choose **Bypass photo check**, then **Continue to Exam Portal**. This can select
one of those53 synthetic records; it cannot authorize another student. No
camera or photo comparison is used by this action. Exam roster/publication,
timing, recording, permissions, AI configuration and retention still apply.

## Grant and identity state

The server issues a signed 15-minute, host-only, HttpOnly, SameSite Strict cookie
with a separate developer-bypass purpose. Frontend storage contains only a scoped
navigation hint; changing storage cannot manufacture server authorization.
Every pre-attempt read/save, EID admission and exam start revalidates the server
grant and current student/EID. Disabling the flag, cookie expiry/tampering or a
changed student identity revokes this exception. A genuine recent photo match
takes precedence at admission/start.

No `matched` record is written and no failed-check history is erased. A bypassed
attempt saves `identity_check_completed = false` and
`identity_review_required = true`; completion is flagged for professor review.
Professor review/progress labels identity as unverified instead of inventing a
number of failed photo comparisons. This exception does not enable the global
demo/minimal mode or remove the assessed recording/live/review features.

## Configuration

The route is disabled by default. It requires
`CYBROS_DEVELOPER_FACE_BYPASS=1`, a loopback client/URL and a loopback Origin when
an Origin is supplied. Only the three exact EIDs above are eligible, resolved
against current database UUIDs. The normal face-verification path remains intact.

P3's private `settings.json` has `developer_face_bypass_enabled: true`, which the
native launcher maps to that backend flag. A protected pre-change settings backup
was retained. Only the verified owned backend was restarted; all required local
services remain ready and global demo/minimal flags remain zero. Turn the private
setting off and restart the owned backend to disable it. Do not commit private
settings or grant cookies. No database migration was needed.

## Measured verification

- Complete offline Python suite: **933 passed, 8 gated skips, 143 subtests**;
  native generated-audio tests enabled. One synthetic assessment fixture was
  updated with existing identity columns; no migration/schema change was needed.
- Frontend: **110 unit tests**, **20 synthetic bypass browser scenarios**,
  **3 environment regression groups**, TypeScript and cache build passed.
  The existing nonfatal bundle-size advisory remains.
- Actual running UI/backend: **all three synthetic EIDs passed** through the
  About-this-check field to the portal. Cookies were HttpOnly/Strict, photo-match
  storage stayed unset, normal IDs/nonlocal origins were denied, and no camera
  or privileged exam-start/provider request occurred. Source exam-session count
  remained zero. Protected evidence:
  `private-data/p3-local/verification/developer-face-bypass-1794892069880.json`.

The live check is repeatable with the existing browser dependencies:

```powershell
node scripts/verify_developer_face_bypass_live.mjs --run
```

Without `--run`, the helper only prints its plan. Its temporary browser contexts
do not alter the user's session. This verifies developer admission, not actual
identity, real-device recording or a complete human assessed exam.
