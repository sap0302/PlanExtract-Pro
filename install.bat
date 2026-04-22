@echo off
:: Always run from the folder where this bat file lives
cd /d "%~dp0"

echo ============================================
echo   PlanExtract Pro - Desktop Installation
echo   by Steppe ^& Stone LLC
echo ============================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Please download and install Node.js from https://nodejs.org
    echo Choose the LTS version ^(recommended^).
    echo.
    echo After installing Node.js, run this installer again.
    pause
    exit /b 1
)

echo [1/5] Node.js found:
node --version
echo.
:: Check Node.js version is 18-22 (LTS)
node -e "const v=parseInt(process.version.slice(1));if(v<18||v>22){console.log('WARNING: Node.js '+process.version+' detected. Please install Node.js 20 LTS from https://nodejs.org');console.log('Versions 18-22 are supported. Version '+process.version+' may cause errors.');process.exit(1)}"
if %ERRORLEVEL% neq 0 (
    pause
    exit /b 1
)
echo.

:: Generate .env file with fresh secrets
echo [2/5] Generating configuration...
if exist .env (
    echo    .env file already exists, skipping...
) else (
    node -e "const c=require('crypto');const secret=c.randomBytes(32).toString('base64');const encKey=c.randomBytes(32).toString('hex');const env='DATABASE_URL=\"file:./dev.db\"\nNEXTAUTH_SECRET=\"'+secret+'\"\nNEXTAUTH_URL=\"http://localhost:3000\"\nAUTH_TRUST_HOST=true\nENCRYPTION_KEY=\"'+encKey+'\"\nCLAUDE_MODEL=\"claude-opus-4-6\"\nHIGH_DPI_RENDER=true\nPDF_RENDER_SCALE=2.5\n';require('fs').writeFileSync('.env',env);console.log('   .env file created with fresh secrets')"
)
echo.

:: Fix Prisma junction point issue on Windows
set PRISMA_ENGINES_MIRROR=https://binaries.prisma.sh
if exist "node_modules\.prisma" (
    echo    Cleaning stale Prisma cache...
    rmdir /s /q "node_modules\.prisma" 2>nul
)
if exist "src\generated" (
    rmdir /s /q "src\generated" 2>nul
)

:: Install dependencies
echo [3/5] Installing dependencies... ^(this may take a few minutes^)
call npm install --ignore-scripts
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

:: Generate Prisma client separately (avoids junction point conflicts)
echo    Generating Prisma client...
call npx prisma generate
echo.

:: Set up database
echo [4/5] Setting up database...
call npx prisma db push
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to set up database.
    pause
    exit /b 1
)
echo.

:: Build production version
echo [5/6] Building production version... ^(this takes 1-2 minutes^)
call npm run build
if %ERRORLEVEL% neq 0 (
    echo WARNING: Production build failed. The app will run in development mode.
    echo.
)
echo.

:: Create admin account
echo [6/6] Creating admin account...
echo.
set /p ADMIN_NAME="Enter admin name (e.g. John Smith): "
set /p ADMIN_EMAIL="Enter admin email: "
set /p ADMIN_PASS="Enter admin password (min 8 characters): "

node -e "const{PrismaClient}=require('@prisma/client');const bcrypt=require('bcryptjs');const p=new PrismaClient();(async()=>{const hash=await bcrypt.hash('%ADMIN_PASS%',12);try{const u=await p.user.create({data:{name:'%ADMIN_NAME%',email:'%ADMIN_EMAIL%',passwordHash:hash,role:'admin'}});console.log('Admin account created: '+u.email)}catch(e){if(e.code==='P2002'){console.log('Account already exists: %ADMIN_EMAIL%')}else{throw e}}await p.$disconnect()})()"

echo.
echo ============================================
echo   Installation Complete!
echo ============================================
echo.
echo To start PlanExtract Pro:
echo   1. Double-click "start.bat"
echo   2. Open http://localhost:3000 in your browser
echo   3. Log in with your admin credentials
echo.
echo IMPORTANT: You need an Anthropic API key to
echo run extractions. Add it in Settings after login.
echo.
pause
