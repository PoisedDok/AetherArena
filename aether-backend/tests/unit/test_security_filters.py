import ast
import pytest

# Extracted AST parser logic from _AetherPython.run
def check_code_ast(code):
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                module_names = [n.name for n in getattr(node, "names", [])]
                if hasattr(node, "module") and node.module:
                    module_names.append(node.module)
                for m in module_names:
                    if m in ("subprocess", "pty", "ctypes"):
                        return f"[Aether Security: Execution refused. As a desktop assistant, use Aether tools instead of raw system commands ({m})]"
            elif isinstance(node, ast.Call):
                func_name = ""
                if isinstance(node.func, ast.Attribute):
                    if isinstance(node.func.value, ast.Name):
                        func_name = f"{node.func.value.id}.{node.func.attr}"
                elif isinstance(node.func, ast.Name):
                    func_name = node.func.id
                
                if func_name in ("os.system", "eval", "exec", "shutil.rmtree") or func_name.startswith("os.exec") or func_name.startswith("os.spawn") or func_name.startswith("os.posix_spawn"):
                    return f"[Aether Security: Execution refused. As a desktop assistant, use Aether tools instead of raw system commands ({func_name})]"
    except SyntaxError:
        pass
    return "ok"

# Extracted audit hook logic
def _aether_audit_hook(event, args):
    if event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn"):
        raise PermissionError("Aether Security: Unauthorized subprocess execution.")
    elif event.startswith("ctypes"):
        raise PermissionError("Aether Security: Unauthorized ctypes invocation.")
    
    file_events = ("open", "os.rename", "os.link", "os.symlink", "os.remove", "os.rmdir", "shutil.copyfile", "sqlite3.connect")
    if event in file_events:
        import os as _os
        for arg in args:
            if isinstance(arg, (str, bytes)):
                try:
                    path = arg.decode("utf-8") if isinstance(arg, bytes) else str(arg)
                    path = _os.path.abspath(path).lower()
                except Exception:
                    continue
                
                if ".ssh/" in path or "/.ssh" in path or ".aws/" in path or "/.aws" in path or "local.env" in path or "network/cookies" in path:
                    raise PermissionError("Aether Security: Access to sensitive file blocked.")

def test_ast_bouncer():
    assert check_code_ast("import os") == "ok"
    assert "Execution refused" in check_code_ast("import subprocess")
    assert "Execution refused" in check_code_ast("from subprocess import Popen")
    assert "Execution refused" in check_code_ast("import ctypes")
    assert "Execution refused" in check_code_ast("os.system('ls')")
    assert "Execution refused" in check_code_ast("os.execl('/bin/sh')")
    assert "Execution refused" in check_code_ast("os.execv('/bin/sh', [])")
    assert "Execution refused" in check_code_ast("os.spawnl(os.P_WAIT, '/bin/sh')")
    assert "Execution refused" in check_code_ast("os.posix_spawn('/bin/sh', [], {})")
    assert "Execution refused" in check_code_ast("eval('1+1')")
    assert "Execution refused" in check_code_ast("shutil.rmtree('/')")
    assert check_code_ast("os.listdir('.')") == "ok"

def test_audit_hook():
    with pytest.raises(PermissionError):
        _aether_audit_hook("subprocess.Popen", ())
        
    with pytest.raises(PermissionError):
        _aether_audit_hook("os.system", ())

    with pytest.raises(PermissionError):
        _aether_audit_hook("os.exec", ())

    with pytest.raises(PermissionError):
        _aether_audit_hook("os.posix_spawn", ())

    with pytest.raises(PermissionError):
        _aether_audit_hook("os.spawn", ())

    with pytest.raises(PermissionError):
        _aether_audit_hook("ctypes.dlopen", ())

    with pytest.raises(PermissionError):
        _aether_audit_hook("open", ("~/.ssh/id_rsa",))

    with pytest.raises(PermissionError):
        _aether_audit_hook("open", ("C:/Users/name/.aws/credentials",))

    with pytest.raises(PermissionError):
        _aether_audit_hook("open", ("/app/local.env",))

    with pytest.raises(PermissionError):
        _aether_audit_hook("os.symlink", ("/Users/name/.ssh/id_rsa", "test"))

    with pytest.raises(PermissionError):
        _aether_audit_hook("sqlite3.connect", ("network/cookies.db",))

    # Legitimate opens should pass
    _aether_audit_hook("open", ("/app/data.txt",))
    _aether_audit_hook("open", ("C:/Users/name/Documents/test.doc",))
