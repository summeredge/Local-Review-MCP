@echo off
set "PYTHON=%USERPROFILE%\Documents\PythonEnvs\local-review-launcher\Scripts\pythonw.exe"
if not exist "%PYTHON%" (
  echo Missing launcher environment: %PYTHON%
  echo Create it with a non-Codex Python, then install requirements.txt.
  pause
  exit /b 1
)
"%PYTHON%" "%~dp0launcher.py"
