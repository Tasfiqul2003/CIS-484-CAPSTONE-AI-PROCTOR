import functools
import os
from pathlib import Path
from threading import Lock


FACE_MATCH_THRESHOLD = 0.363
FRAME_MATCH_COUNT = 2
FRAME_COUNT = 3
MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096


class FaceMatcherUnavailable(RuntimeError):
    pass


class FaceImageInvalid(ValueError):
    pass


class OpenCVFaceMatcher:
    def __init__(self, detector_path: Path, recognizer_path: Path):
        try:
            import cv2
            import numpy as np
        except ImportError as error:
            raise FaceMatcherUnavailable(
                "The OpenCV face-matching dependency is not installed."
            ) from error

        if not detector_path.is_file() or not recognizer_path.is_file():
            raise FaceMatcherUnavailable(
                "Face-matching model files are not configured on this server."
            )

        try:
            self._cv2 = cv2
            self._np = np
            self._lock = Lock()
            self._detector = cv2.FaceDetectorYN.create(
                str(detector_path), "", (320, 320), 0.9, 0.3, 5000
            )
            self._recognizer = cv2.FaceRecognizerSF.create(
                str(recognizer_path), ""
            )
        except (AttributeError, cv2.error) as error:
            raise FaceMatcherUnavailable(
                "The configured OpenCV face-matching models could not be loaded."
            ) from error

    def _decode_single_face(self, image_bytes: bytes):
        if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            raise FaceImageInvalid("Each captured image must be no larger than 3 MB.")

        image = self._cv2.imdecode(
            self._np.frombuffer(image_bytes, dtype=self._np.uint8),
            self._cv2.IMREAD_COLOR,
        )
        if image is None:
            raise FaceImageInvalid("A captured image could not be decoded.")

        height, width = image.shape[:2]
        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise FaceImageInvalid("Captured image dimensions are too large.")

        self._detector.setInputSize((width, height))
        _, faces = self._detector.detect(image)
        if faces is None or len(faces) != 1:
            raise FaceImageInvalid(
                "Each image must contain exactly one clearly visible face. Please try again."
            )
        return image, faces[0][:-1]

    def compare_frames(
        self,
        reference_photo: bytes,
        frame_photos: list[bytes],
    ) -> bool:
        if len(frame_photos) != FRAME_COUNT:
            raise FaceImageInvalid("The capture must provide exactly three frames.")

        with self._lock:
            reference, reference_face = self._decode_single_face(reference_photo)
            reference_crop = self._recognizer.alignCrop(reference, reference_face)
            reference_features = self._recognizer.feature(reference_crop)

            scores = []
            for frame_bytes in frame_photos:
                frame, frame_face = self._decode_single_face(frame_bytes)
                frame_crop = self._recognizer.alignCrop(frame, frame_face)
                frame_features = self._recognizer.feature(frame_crop)
                scores.append(float(self._recognizer.match(
                    reference_features,
                    frame_features,
                    self._cv2.FaceRecognizerSF_FR_COSINE,
                )))

            return frame_set_matches(scores)


@functools.lru_cache(maxsize=1)
def _load_matcher(detector_path: str, recognizer_path: str) -> OpenCVFaceMatcher:
    return OpenCVFaceMatcher(Path(detector_path), Path(recognizer_path))


def get_face_matcher() -> OpenCVFaceMatcher:
    detector_path = os.getenv("FACE_DETECTOR_MODEL_PATH", "")
    recognizer_path = os.getenv("FACE_RECOGNIZER_MODEL_PATH", "")
    if not detector_path or not recognizer_path:
        raise FaceMatcherUnavailable(
            "Set FACE_DETECTOR_MODEL_PATH and FACE_RECOGNIZER_MODEL_PATH on the server."
        )
    return _load_matcher(detector_path, recognizer_path)


def frame_set_matches(scores: list[float]) -> bool:
    return len(scores) == FRAME_COUNT and sum(
        score >= FACE_MATCH_THRESHOLD for score in scores
    ) >= FRAME_MATCH_COUNT


def face_check_decision(matched: bool, attempts_so_far: int) -> dict[str, int | str | bool]:
    attempts = attempts_so_far + 1
    review_required = not matched and attempts >= 3
    return {
        "attempt": attempts,
        "allowed": matched,
        "matched": matched,
        "review_required": review_required,
        "status": "matched" if matched else "no_match",
    }
