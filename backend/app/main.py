from fastapi import FastAPI, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session
import httpx
import os

from app.db import get_db

app = FastAPI(title="AI Oral Exam Proctor")


@app.get("/")
def root():
    return {
        "message": "AI Oral Exam Proctor backend is running"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy"
    }


@app.get("/db")
def database_test(db: Session = Depends(get_db)):
    result = db.execute(text("SELECT current_database();"))
    database_name = result.scalar()

    return {
        "status": "connected",
        "database": database_name
    }


@app.get("/ollama")
async def ollama_test():
    ollama_url = os.getenv("OLLAMA_URL", "http://ollama:11434")

    async with httpx.AsyncClient() as client:
        response = await client.get(f"{ollama_url}/api/tags")

    return response.json()
