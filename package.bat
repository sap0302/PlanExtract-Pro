@echo off
cd /d "%~dp0"
echo ============================================
echo   Packaging PlanExtract Pro for client
echo ============================================
echo.

set OUTPUT=..\PlanExtract-Pro-Client

:: Clean previous package
if exist "%OUTPUT%" rmdir /s /q "%OUTPUT%"
mkdir "%OUTPUT%"

:: Copy everything except machine-specific files
echo Copying files...
robocopy . "%OUTPUT%" /E /XD node_modules .next .git .claude /XF dev.db .env .env.local *.db-journal PlanExtract-Pro.zip package.bat 2>nul >nul

echo.
echo Creating zip file...
powershell -Command "Compress-Archive -Path '%OUTPUT%\*' -DestinationPath '..\PlanExtract-Pro-Client.zip' -Force"

:: Clean temp folder
rmdir /s /q "%OUTPUT%"

echo.
echo ============================================
echo   Package created: ..\PlanExtract-Pro-Client.zip
echo ============================================
echo.
echo Give this zip to your client. They extract it
echo to C:\PlanExtract-Pro and run install.bat
echo.
pause
