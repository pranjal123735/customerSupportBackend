# Knowledge Base Fix for Policy Questions

## Problem
When users ask policy-related questions like "What's your return policy?", the system was responding with "Sorry, I'm having trouble processing your message" instead of providing the correct policy information from the knowledge base.

## Root Cause
The knowledge base (MongoDB collection `knowledge_base`) was **empty** - it didn't contain any embeddings from the `ecommerce-knowledge.json` file. 

### Why This Matters
- **Policy questions** (return policy, refund policy, cancellation policy, etc.) require information from the **knowledge base** (JSON file)
- **Order-specific questions** (track my order, cancel order #1001) require information from the **database** (customers, orders, products collections)

The system has two data sources:
1. **Knowledge Base** (`knowledge_base` collection) - Contains company policies, procedures, general information
2. **Transactional Database** (`customers`, `orders`, `products` collections) - Contains customer orders, tracking info, etc.

## Solution

### 1. Created Knowledge Base Population Script
Created `backend/scripts/populateKnowledgeBase.js` that:
- Reads `backend/data/ecommerce-knowledge.json`
- Breaks it into semantic chunks (policies, menu items, support info, etc.)
- Creates embeddings for each chunk using Gemini
- Stores chunks + embeddings in MongoDB `knowledge_base` collection

### 2. Added NPM Script
Added to `package.json`:
```json
"populate-kb": "node scripts/populateKnowledgeBase.js"
```

### 3. Improved Error Handling
Updated `customerSupportAgent.js` to:
- Detect when knowledge base is empty
- Log helpful warnings with instructions
- Distinguish between knowledge base failures and database queries

## How to Fix

### Step 1: Populate the Knowledge Base
```bash
cd backend
npm run populate-kb
```

This will:
- Connect to MongoDB
- Clear existing knowledge base
- Process all policies, menu items, and support info
- Create embeddings for each item
- Insert into `knowledge_base` collection

Expected output:
```
✅ Connected to MongoDB
📚 Processing knowledge base...
📝 Created 15 knowledge chunks
🔄 Creating embeddings...
  Progress: 15/15
✅ Successfully populated 15 knowledge items
📊 Total documents in knowledge_base: 15

📋 Sample policy entries:
  - Refund Policy: Refund Policy: Full refunds are provided for: Order not delivered...
  - Return Policy: Return Policy: You can return items within 30 days of delivery...
  - Cancellation Policy: Cancellation Policy: Free cancellation Within 5 minutes...
```

### Step 2: Restart the Server
```bash
npm start
```

### Step 3: Test Policy Questions
Now when users ask:
- "What's your return policy?"
- "How do I get a refund?"
- "What's your cancellation policy?"
- "Do you offer free delivery?"

The system will:
1. Create an embedding for the question
2. Search the `knowledge_base` collection using vector similarity
3. Find the most relevant policy chunks
4. Generate a response using that policy information

## Verification

### Check Knowledge Base Contents
```javascript
// In MongoDB shell or Compass
use ecommerce_rag
db.knowledge_base.find({ category: "policy" })
```

You should see documents like:
```json
{
  "_id": ObjectId("..."),
  "category": "policy",
  "title": "Refund Policy",
  "content": "Refund Policy: Full refunds are provided for: ...",
  "embedding": [0.123, -0.456, ...], // 768-dimensional vector
  "created_at": ISODate("2026-05-12T...")
}
```

### Test the Fix
```bash
# Test policy question
curl -X POST http://localhost:3000/api/voice/process \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is your return policy?",
    "userId": "test_user"
  }'
```

Expected response:
```json
{
  "response": "Our return policy allows you to return items within 30 days of delivery. Full refunds are provided for wrong orders, quality issues, or non-delivery. Refunds take 3-5 business days to process.",
  "action": "answered_question",
  "resolved": false
}
```

## Architecture Overview

```
User Question: "What's your return policy?"
        ↓
1. Create embedding for question
        ↓
2. Vector search in knowledge_base collection
        ↓
3. Find top 5 most similar chunks (cosine similarity)
        ↓
4. Pass relevant chunks to LLM as context
        ↓
5. LLM generates answer using policy information
        ↓
Response: "Our return policy allows..."
```

## Key Files Modified

1. **backend/scripts/populateKnowledgeBase.js** (NEW)
   - Populates knowledge base from JSON

2. **backend/package.json**
   - Added `populate-kb` script

3. **backend/src/services/customerSupportAgent.js**
   - Improved error handling for empty knowledge base
   - Added helpful logging

## Future Improvements

1. **Auto-populate on startup** - Check if knowledge base is empty and auto-populate
2. **Incremental updates** - Update only changed policies instead of full rebuild
3. **Multi-language support** - Create embeddings for Hindi/Hinglish versions
4. **Knowledge versioning** - Track when policies change
5. **Analytics** - Track which policies are asked about most

## Troubleshooting

### "No documents in knowledge_base collection"
Run: `npm run populate-kb`

### "Embedding creation failed"
Check: `GEMINI_API_KEY` in `.env` file

### "MongoDB connection failed"
Check: `MONGODB_URI` in `.env` file and IP whitelist in MongoDB Atlas

### Still getting "trouble processing your message"
1. Check server logs for specific error
2. Verify knowledge base has documents: `db.knowledge_base.countDocuments()`
3. Test embedding creation manually
4. Check if RAG service initialized properly
