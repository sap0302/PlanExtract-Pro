#!/bin/bash
cd "$(dirname "$0")"

echo "============================================"
echo "  PlanExtract Pro by Steppe & Stone LLC"
echo "============================================"
echo ""

# Build production version if not already built
if [ ! -f ".next/BUILD_ID" ]; then
    echo "Building production version... (first time only, takes 1-2 minutes)"
    npm run build
    if [ $? -ne 0 ]; then
        echo "Build failed. Falling back to development mode..."
        npm run dev
        exit 1
    fi
    echo ""
fi

echo "Starting server..."
echo ""
echo "Press Ctrl+C to stop the server."
echo "============================================"
echo ""

# Open browser after a short delay
(sleep 3 && open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) &

npm run start 2>&1 | tee logs.txt
echo ""
echo "Server stopped."
