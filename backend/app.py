"""FlashSlot Flask application factory. Serves the JSON API and the static frontend."""
import logging
import os

from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
from postgrest.exceptions import APIError
from werkzeug.exceptions import HTTPException

from backend.config import Config
from backend.routes.admin_routes import bp as admin_bp
from backend.routes.auth_routes import bp as auth_bp
from backend.routes.booking_routes import bp as booking_bp
from backend.routes.waitlist_routes import bp as waitlist_bp

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))


def create_app():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = Flask(__name__, static_folder=None)
    app.config["SECRET_KEY"] = Config.SECRET_KEY
    CORS(app, resources={r"/api/*": {"origins": Config.CORS_ORIGINS}})

    for blueprint in (auth_bp, booking_bp, waitlist_bp, admin_bp):
        app.register_blueprint(blueprint)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "configured": not Config.missing()})

    @app.get("/api/config")
    def public_config():
        """Public values the browser needs to initialise the Supabase JS SDK.
        The anon key is designed to be public; the service-role key never leaves the server."""
        return jsonify({"supabaseUrl": Config.SUPABASE_URL, "supabaseAnonKey": Config.SUPABASE_ANON_KEY})

    @app.errorhandler(APIError)
    def handle_db_error(err):
        logging.getLogger("flashslot").warning("Database error: %s", err)
        message = getattr(err, "message", None) or "The database rejected that request."
        return jsonify({"error": message}), 400

    @app.errorhandler(404)
    def not_found(_err):
        return jsonify({"error": "Not found."}), 404

    @app.errorhandler(Exception)
    def handle_unexpected(err):
        if isinstance(err, HTTPException):
            return jsonify({"error": err.description}), err.code
        logging.getLogger("flashslot").exception("Unhandled error: %s", err)
        return jsonify({"error": "Something went wrong on our side. Try again."}), 500

    # --- Static frontend -------------------------------------------------
    @app.get("/")
    def home():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/<path:filename>")
    def frontend_files(filename):
        if filename.startswith("api/"):
            return jsonify({"error": "Not found."}), 404
        return send_from_directory(FRONTEND_DIR, filename)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG") == "1")
