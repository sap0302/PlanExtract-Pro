@echo off
cd /d "%~dp0"
echo ============================================
echo   PlanExtract Pro by Steppe ^& Stone LLC
echo ============================================
echo.

:: Build production version if not already built
if not exist ".next\BUILD_ID" (
    echo Building production version... ^(first time only, takes 1-2 minutes^)
    call npm run build
    if %ERRORLEVEL% neq 0 (
        echo Build failed. Falling back to development mode...
        call npm run dev
        pause
        exit /b 1
    )
    echo.
)

echo Starting server...
echo.
echo Press Ctrl+C to stop the server.
echo ============================================
echo.
:: Open browser after a short delay (server needs a moment to start)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"
:: Log output to file AND terminal
powershell -Command "npm run start 2>&1 | Tee-Object -FilePath logs.txt"
echo.
echo Server stopped.
pause
