# Student photo comparison prototype

The student flow uses the official reference photo imported with the exam
roster. A student records a short 3–6 second camera clip; the browser extracts
three still frames and sends only those frames to the backend for comparison.
The video clip stays in browser memory and is not uploaded or saved. The
backend stores the official roster photo in the `students` table and stores
only the comparison outcome and attempt count.

This short identity-check clip is separate from the full exam recording. See
[exam recording and professor review](exam-video-review.md) for recording and
retention details.

The comparison uses OpenCV Zoo SFace and YuNet on the server CPU. The current
prototype uses the upstream SFace cosine threshold of `0.363` and requires at
least two of three frames to meet it. This threshold and policy have not been
validated for this application, its cameras, or its students. This is a face
photo comparison, not liveness detection, proof that a physical JACard is
authentic, or a validated identity decision. A non-match never grants exam
access. After three recent valid non-matches, access remains blocked and the
professor's roster progress view shows that the student needs assistance.
Invalid or unusable captures do not count as a non-match.

## Import official reference photos

Use the professor's **Student Exam Roster** uploader and select a ZIP containing:

```text
roster.csv
photos/
  EID123.jpg
  EID456.png
```

`roster.csv` must have `name,email,eid` columns. Each roster EID must have
exactly one corresponding image named `photos/<EID>.jpg`, `.jpeg`, or `.png`.
The archive is limited to 25 MB; each image is limited to 5 MB and 4096 × 4096
pixels. Existing CSV-only roster uploads remain supported and do not delete a
previously imported photo.

Imported official photos persist in the database and are not returned by the
student or professor roster APIs. Protect the database, its backups, and the
authorized offline import process as sensitive student data. Do not put real
student photos in source control or test fixtures.

## Configure models on the server

No model weights are stored in this repository. Obtain the exact model files
through an approved connected staging system, review their licenses, and
transfer them to a protected read-only directory on the air-gapped server:

- YuNet detector: `face_detection_yunet_2023mar.onnx` ([model directory and
  MIT license](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)).
- SFace recognizer: `face_recognition_sface_2021dec.onnx` ([model directory and
  Apache-2.0 license](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)).

Set these backend environment variables to the mounted file paths:

```text
FACE_DETECTOR_MODEL_PATH=/models/face_detection_yunet_2023mar.onnx
FACE_RECOGNIZER_MODEL_PATH=/models/face_recognition_sface_2021dec.onnx
```

For the repository Compose stack, set `FACE_MODELS_DIR` to the host directory
containing both files; it is mounted read-only at `/models`. Do not copy model
weights into the image or commit them. If either model or the OpenCV dependency
is unavailable, the face-check endpoint returns an explicit service error and
does not count an attempt or permit access.

Apply migrations `013_student_photo_verification.sql`,
`014_exam_video_recordings.sql`, and `015_block_face_check_overrides.sql` in
numeric order before using the complete flow.

Camera access requires a secure browser context: HTTPS, or `localhost` for
local development. An air-gapped server normally needs a certificate trusted
by the student devices.

## Validation and limitations

Automated tests use synthetic images and mocked match outcomes. They exercise
ZIP validation, attempt limits, server-side exam gating, and professor support
indicators; they do not measure biometric accuracy or fairness. The upstream
SFace threshold is only a starting point. Do not treat this prototype as
reliable or deploy it for real exam decisions until the institution has
approved the processing, selected retention and support procedures, and
validated it under representative conditions. A support indicator is not an
identity confirmation.
