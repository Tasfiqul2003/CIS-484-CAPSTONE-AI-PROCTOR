import io
import zipfile

from PIL import Image
import pytest

from backend.app.roster_photos import read_photo_roster_archive


def jpeg_bytes():
    image = Image.new("RGB", (32, 32), color="white")
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def make_archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return output.getvalue()


def test_photo_roster_archive_reads_csv_and_eid_named_jpeg():
    photo = jpeg_bytes()
    archive = make_archive([
        ("roster.csv", "name,email,eid\nTest Student,test@example.invalid,TEST123\n"),
        ("photos/TEST123.jpg", photo),
    ])

    csv_contents, photos = read_photo_roster_archive(archive)

    assert csv_contents.startswith(b"name,email,eid")
    assert photos == {"test123": photo}


@pytest.mark.parametrize(
    "entries",
    [
        [("roster.csv", "name,email,eid\n")],
        [
            ("roster.csv", "name,email,eid\n"),
            ("../photos/TEST123.jpg", jpeg_bytes()),
        ],
        [
            ("roster.csv", "name,email,eid\n"),
            ("photos/TEST123.jpg", b"not an image"),
        ],
    ],
)
def test_photo_roster_archive_rejects_missing_or_unsafe_photos(entries):
    with pytest.raises(ValueError):
        read_photo_roster_archive(make_archive(entries))
