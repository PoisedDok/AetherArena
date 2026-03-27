import sys
from app.main import create_app
from fastapi.routing import APIRoute

app = create_app()
routes = [route for route in app.routes if isinstance(route, APIRoute)]
print(f"Total endpoints: {len(routes)}")

# Let's also count route modules
import glob
modules = glob.glob('app/api/**/*.py', recursive=True)
print(f"Total API modules: {len(modules)}")
