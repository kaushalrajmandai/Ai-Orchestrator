"""SQLAlchemy engine and session setup.

The Node/Prisma service owns the schema and migrations. This service connects
to the same PostgreSQL database to read project/task state and run the
orchestration pipeline, so we only set up a connection here — no model
definitions or migrations.
"""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,  # transparently recover from dropped connections
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a database session per request."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
