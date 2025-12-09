"""Streaming application package."""

from __future__ import annotations

from flask import Flask


def create_app() -> Flask:
    """Delegate to the main module's application factory."""
    from main import create_app as _create_app

    return _create_app()


__all__ = ["create_app"]
