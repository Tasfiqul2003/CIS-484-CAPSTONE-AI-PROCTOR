import io
import re
import stat
import zipfile
from pathlib import PurePosixPath

from PIL import Image, UnidentifiedImageError


MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_ARCHIVE_FILES = 502
MAX_CSV_BYTES = 2 * 1024 * 1024
MAX_PHOTO_BYTES = 5 * 1024 * 1024
MAX_TOTAL_PHOTO_BYTES = 20 * 1024 * 1024
MAX_PHOTO_DIMENSION = 4096
PHOTO_PATH = re.compile(r"photos/([A-Za-z0-9._-]{1,64})\.(jpg|jpeg|png)", re.IGNORECASE)


def _read_photo(data: bytes, filename: str) -> bytes:
    if not data or len(data) > MAX_PHOTO_BYTES:
        raise ValueError(f"{filename} must be no larger than 5 MB.")

    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"JPEG", "PNG"}:
                raise ValueError(f"{filename} must be a JPEG or PNG image.")
            width, height = image.size
            if width > MAX_PHOTO_DIMENSION or height > MAX_PHOTO_DIMENSION:
                raise ValueError(f"{filename} dimensions must not exceed 4096 × 4096.")
            image.verify()
    except (
        OSError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
    ) as error:
        raise ValueError(f"{filename} is not a valid JPEG or PNG image.") from error

    return data


def read_photo_roster_archive(contents: bytes) -> tuple[bytes, dict[str, bytes]]:
    if not contents or len(contents) > MAX_ARCHIVE_BYTES:
        raise ValueError("The ZIP archive must be no larger than 25 MB.")

    try:
        archive = zipfile.ZipFile(io.BytesIO(contents))
    except zipfile.BadZipFile as error:
        raise ValueError("The upload is not a valid ZIP archive.") from error

    with archive:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_FILES:
            raise ValueError("The ZIP archive contains too many files.")

        roster_info = None
        photo_infos: dict[str, zipfile.ZipInfo] = {}
        total_photo_bytes = 0

        for info in entries:
            name = info.filename
            if name in ("photos/",):
                continue
            if (
                info.is_dir()
                or "\\" in name
                or name.startswith("/")
                or ".." in PurePosixPath(name).parts
                or stat.S_ISLNK(info.external_attr >> 16)
                or info.flag_bits & 0x1
            ):
                raise ValueError("The ZIP archive contains an unsafe entry.")

            if name == "roster.csv":
                if roster_info is not None:
                    raise ValueError("The ZIP archive must contain one roster.csv.")
                if info.file_size > MAX_CSV_BYTES:
                    raise ValueError("roster.csv must be no larger than 2 MB.")
                roster_info = info
                continue

            match = PHOTO_PATH.fullmatch(name)
            if not match:
                raise ValueError(
                    "Use roster.csv and photos/<EID>.jpg, .jpeg, or .png only."
                )

            eid = match.group(1).casefold()
            if eid in photo_infos:
                raise ValueError(f"The ZIP archive contains duplicate photos for EID {match.group(1)}.")
            if info.file_size > MAX_PHOTO_BYTES:
                raise ValueError(f"Photo for EID {match.group(1)} exceeds 5 MB.")
            if info.compress_size == 0 and info.file_size > 0:
                raise ValueError("The ZIP archive contains an invalid compressed file.")
            if info.compress_size and info.file_size > info.compress_size * 100:
                raise ValueError("The ZIP archive contains an unusually compressed file.")

            total_photo_bytes += info.file_size
            if total_photo_bytes > MAX_TOTAL_PHOTO_BYTES:
                raise ValueError("Photos in the ZIP archive must total no more than 20 MB.")
            photo_infos[eid] = info

        if roster_info is None:
            raise ValueError("The ZIP archive must contain roster.csv at its root.")
        if not photo_infos:
            raise ValueError("The ZIP archive must contain official photos in photos/.")

        try:
            roster_csv = archive.read(roster_info)
            photos = {
                eid: _read_photo(archive.read(info), info.filename)
                for eid, info in photo_infos.items()
            }
        except (OSError, RuntimeError, zipfile.BadZipFile) as error:
            raise ValueError("Unable to read the roster ZIP archive.") from error

    return roster_csv, photos
