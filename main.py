from __future__ import annotations

import os
from pathlib import Path

from flask import Flask

from streaming_app.routes import bp as main_blueprint


def create_flask_app() -> Flask:
    project_root = Path(__file__).resolve().parent
    templates_path = project_root / "templates"
    static_path = project_root / "static"
    return Flask(
        __name__,
        template_folder=str(templates_path),
        static_folder=str(static_path),
    )


def apply_configuration(app: Flask) -> None:
    upload_root = Path(app.root_path) / "media"
    app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key")
    app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024 * 1024 
    app.config["UPLOAD_ROOT"] = upload_root
    upload_root.mkdir(parents=True, exist_ok=True)


def register_blueprints(app: Flask) -> None:
    app.register_blueprint(main_blueprint)


def create_app() -> Flask:
    app = create_flask_app()
    apply_configuration(app)
    register_blueprints(app)
    return app


def main() -> None:
    app = create_app()
    app.run(debug=True, host="0.0.0.0", port=5000)


if __name__ == "__main__":
    main()
