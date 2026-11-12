@echo off
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 goto nopython

if not exist .venv\Scripts\python.exe (
  echo Creating a private Python environment...
  python -m venv .venv
  if errorlevel 1 goto venvfail
)

.venv\Scripts\python.exe -c "import fastapi, uvicorn, PIL, fpdf, numpy, imageio_ffmpeg" >nul 2>&1
if not errorlevel 1 goto launch

echo Installing libraries. The first time this can take a minute...
.venv\Scripts\python.exe -m pip install -r requirements.txt
if not errorlevel 1 goto launch

echo.
echo The download failed a certificate check. That can happen while you are online.
echo Antivirus and some school or office networks replace the site certificate.
echo Retrying the Python package sites with that check relaxed.
echo.
.venv\Scripts\python.exe -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org -r requirements.txt
if errorlevel 1 goto pipfail

:launch
.venv\Scripts\python.exe server.py %*
if errorlevel 1 pause
exit /b 0

:nopython
echo Python was not found.
echo Install Python 3.11 or newer from https://www.python.org/downloads/
echo On the first screen, check "Add python.exe to PATH", then run this file again.
pause
exit /b 1

:venvfail
echo Could not create the Python environment.
echo Close this window, delete the .venv folder if it exists, and run this file again.
pause
exit /b 1

:pipfail
echo.
echo The libraries did not install, so the app cannot start.
echo If the message above mentions SSL or certificate, check the computer's date and time,
echo then turn off HTTPS scanning in the antivirus and run this file again.
echo You can also delete the .venv folder in this directory and run this file again.
pause
exit /b 1
