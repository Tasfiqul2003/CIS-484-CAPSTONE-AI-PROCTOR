from fastapi import FastAPI, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session
import httpx
import os

from .db import get_db

app = FastAPI(title="AI Oral Exam Proctor")


@app.get("/")
def root():
    return {"message": "AI Oral Exam Proctor backend is running"}


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.get("/health/db")
def health_db(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"db": "ok"}


@app.get("/ollama")
async def ollama_test():
    ollama_url = os.getenv("OLLAMA_URL", "http://ollama:11434")

    async with httpx.AsyncClient() as client:
        response = await client.get(f"{ollama_url}/api/tags")

    return response.json()
