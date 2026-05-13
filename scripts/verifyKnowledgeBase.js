const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function verify() {
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    const db = client.db('ecommerce_rag');
    
    const docs = await db.collection('knowledge_base')
      .find({})
      .project({ category: 1, title: 1, _id: 0 })
      .toArray();
    
    console.log('\n📚 Knowledge Base Contents:\n');
    
    const byCategory = {};
    docs.forEach(doc => {
      if (!byCategory[doc.category]) {
        byCategory[doc.category] = [];
      }
      byCategory[doc.category].push(doc.title);
    });
    
    Object.entries(byCategory).forEach(([category, titles]) => {
      console.log(`\n🏷️  ${category.toUpperCase()} (${titles.length} items):`);
      titles.forEach(title => console.log(`   - ${title}`));
    });
    
    console.log(`\n✅ Total: ${docs.length} knowledge items in database\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await client.close();
  }
}

verify();
