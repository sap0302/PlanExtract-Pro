#!/bin/bash
cd "$(dirname "$0")"

echo "============================================"
echo "  PlanExtract Pro - Desktop Installation"
echo "  by Steppe & Stone LLC"
echo "============================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo "Please install Node.js from https://nodejs.org"
    echo "Or run: brew install node"
    echo ""
    echo "After installing Node.js, run this installer again."
    exit 1
fi

echo "[1/6] Node.js found:"
node --version
echo ""

# Check Node.js version is 18-22 (LTS)
node -e "const v=parseInt(process.version.slice(1));if(v<18||v>22){console.log('WARNING: Node.js '+process.version+' detected. Please install Node.js 20 LTS from https://nodejs.org');process.exit(1)}"
if [ $? -ne 0 ]; then
    exit 1
fi
echo ""

# Generate .env file with fresh secrets
echo "[2/6] Generating configuration..."
if [ -f .env ]; then
    echo "   .env file already exists, skipping..."
else
    node -e "const c=require('crypto');const secret=c.randomBytes(32).toString('base64');const encKey=c.randomBytes(32).toString('hex');const env='DATABASE_URL=\"file:./dev.db\"\nNEXTAUTH_SECRET=\"'+secret+'\"\nNEXTAUTH_URL=\"http://localhost:3000\"\nAUTH_TRUST_HOST=true\nENCRYPTION_KEY=\"'+encKey+'\"\nCLAUDE_MODEL=\"claude-opus-4-6\"\nHIGH_DPI_RENDER=true\nPDF_RENDER_SCALE=2.5\n';require('fs').writeFileSync('.env',env);console.log('   .env file created with fresh secrets')"
fi
echo ""

# Install dependencies
echo "[3/6] Installing dependencies... (this may take a few minutes)"
npm install --ignore-scripts
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install dependencies."
    exit 1
fi

# Generate Prisma client
echo "   Generating Prisma client..."
npx prisma generate
echo ""

# Set up database
echo "[4/6] Setting up database..."
npx prisma db push
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to set up database."
    exit 1
fi
echo ""

# Build production version
echo "[5/6] Building production version... (this takes 1-2 minutes)"
npm run build
if [ $? -ne 0 ]; then
    echo "WARNING: Production build failed. The app will run in development mode."
fi
echo ""

# Create admin account
echo "[6/6] Creating admin account..."
echo ""
read -p "Enter admin name (e.g. John Smith): " ADMIN_NAME
read -p "Enter admin email: " ADMIN_EMAIL
read -p "Enter admin password (min 8 characters): " ADMIN_PASS

node -e "const{PrismaClient}=require('@prisma/client');const bcrypt=require('bcryptjs');const p=new PrismaClient();(async()=>{const hash=await bcrypt.hash('$ADMIN_PASS',12);try{const u=await p.user.create({data:{name:'$ADMIN_NAME',email:'$ADMIN_EMAIL',passwordHash:hash,role:'admin'}});console.log('Admin account created: '+u.email)}catch(e){if(e.code==='P2002'){console.log('Account already exists: $ADMIN_EMAIL')}else{throw e}}await p.\$disconnect()})()"

echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "To start PlanExtract Pro:"
echo "  1. Run: ./start.sh"
echo "  2. Open http://localhost:3000 in your browser"
echo "  3. Log in with your admin credentials"
echo ""
echo "IMPORTANT: You need an Anthropic API key to"
echo "run extractions. Add it in Settings after login."
echo ""
