"""Application settings loaded from environment variables."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    host: str = "0.0.0.0"
    port: int = 8000

    # Same PostgreSQL database as the Node API, accessed via psycopg v3.
    database_url: str = (
        "postgresql+psycopg://postgres:postgres@localhost:5432/ai_orchestrator"
    )

    # Internal URL of the Node API for callbacks/webhooks (used later).
    api_url: str = "http://localhost:4000"

    # Redis connection for the pipeline queue (used later).
    redis_url: str = "redis://localhost:6379"

    # Shared secret authenticating internal calls to the Node API.
    internal_secret: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
