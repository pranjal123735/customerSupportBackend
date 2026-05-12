const { MongoClient } = require('mongodb');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

dns.setServers(['8.8.8.8', '8.8.4.4']);

class KnowledgeBasePopulator {
  constructor() {
    this.mongoClient = null;
    this.db = null;
    this.genai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    });
  }

  async connect() {
    try {
      const options = {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        family: 4
      };

      console.log('⏳ Connecting to MongoDB...');
      this.mongoClient = new MongoClient(process.env.MONGODB_URI, options);
      await this.mongoClient.connect();
      await this.mongoClient.db('admin').command({ ping: 1 });
      
      this.db = this.mongoClient.db('ecommerce_rag');
      console.log('✅ Connected to MongoDB');
    } catch (error) {
      console.error('❌ MongoDB connection failed:', error.message);
      throw error;
    }
  }

  async createEmbedding(text) {
    try {
      const response = await this.genai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: text
      });
      return response.embeddings[0].values;
    } catch (error) {
      console.error('❌ Embedding creation failed:', error.message);
      throw error;
    }
  }

  async populateFromJSON() {
    try {
      // Load knowledge base JSON
      const knowledgePath = path.join(__dirname, '../data/ecommerce-knowledge.json');
      const knowledgeData = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));

      console.log('📚 Processing knowledge base...');

      const chunks = [];

      // Process company info
      if (knowledgeData.company) {
        chunks.push({
          category: 'company',
          title: 'Company Information',
          content: `${knowledgeData.company.name}: ${knowledgeData.company.description}. Contact: ${knowledgeData.company.contact.phone}, ${knowledgeData.company.contact.email}. Hours: ${knowledgeData.company.contact.hours}`
        });
      }

      // Process policies - MOST IMPORTANT FOR POLICY QUESTIONS
      if (knowledgeData.policies) {
        // Delivery policy
        if (knowledgeData.policies.delivery) {
          const delivery = knowledgeData.policies.delivery;
          chunks.push({
            category: 'policy',
            title: 'Delivery Policy',
            content: `Delivery Policy: Standard delivery time is ${delivery.standard_time}. We guarantee ${delivery.guarantee}. Delivery fee is ${delivery.delivery_fee}, with free delivery on orders over ${delivery.free_delivery_minimum}. We deliver within ${delivery.coverage_area}. ${delivery.weather_policy}`
          });
        }

        // Refund policy - CRITICAL
        if (knowledgeData.policies.refund) {
          const refund = knowledgeData.policies.refund;
          chunks.push({
            category: 'policy',
            title: 'Refund Policy',
            content: `Refund Policy: Full refunds are provided for: ${refund.full_refund_conditions.join(', ')}. Partial refunds for: ${refund.partial_refund_conditions.join(', ')}. No refunds for: ${refund.no_refund_conditions.join(', ')}. Refund processing time: ${refund.refund_processing_time}.`
          });
        }

        // Return policy (part of refund)
        if (knowledgeData.policies.refund) {
          chunks.push({
            category: 'policy',
            title: 'Return Policy',
            content: `Return Policy: You can return items within 30 days of delivery. Full refunds are provided for wrong orders, quality issues, or non-delivery. Returns must be initiated within the return window. Refunds take ${knowledgeData.policies.refund.refund_processing_time} to process.`
          });
        }

        // Cancellation policy
        if (knowledgeData.policies.cancellation) {
          const cancel = knowledgeData.policies.cancellation;
          chunks.push({
            category: 'policy',
            title: 'Cancellation Policy',
            content: `Cancellation Policy: Free cancellation ${cancel.free_cancellation}. ${cancel.partial_charge}. ${cancel.no_cancellation}.`
          });
        }

        // Payment policy
        if (knowledgeData.policies.payment) {
          const payment = knowledgeData.policies.payment;
          chunks.push({
            category: 'policy',
            title: 'Payment Policy',
            content: `Payment Policy: We accept ${payment.accepted_methods.join(', ')}. ${payment.payment_processing}. ${payment.tip_policy}. ${payment.surge_pricing}.`
          });
        }
      }

      // Process menu categories
      if (knowledgeData.menu_categories) {
        knowledgeData.menu_categories.forEach(category => {
          chunks.push({
            category: 'menu',
            title: `${category.name} Menu`,
            content: `${category.name}: Popular items include ${category.popular_items.join(', ')}. Average prep time: ${category.average_prep_time}. Dietary options: ${category.dietary_options.join(', ')}.`
          });
        });
      }

      // Process common issues
      if (knowledgeData.common_issues) {
        Object.entries(knowledgeData.common_issues).forEach(([key, value]) => {
          const title = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          chunks.push({
            category: 'support',
            title: title,
            content: JSON.stringify(value)
          });
        });
      }

      // Process account management
      if (knowledgeData.account_management) {
        chunks.push({
          category: 'account',
          title: 'Account Management',
          content: JSON.stringify(knowledgeData.account_management)
        });
      }

      // Process promotions
      if (knowledgeData.promotions) {
        chunks.push({
          category: 'promotions',
          title: 'Current Promotions',
          content: JSON.stringify(knowledgeData.promotions)
        });
      }

      console.log(`📝 Created ${chunks.length} knowledge chunks`);

      // Create embeddings and insert into MongoDB
      console.log('🔄 Creating embeddings...');
      
      // Clear existing knowledge base
      await this.db.collection('knowledge_base').deleteMany({});
      console.log('🗑️  Cleared existing knowledge base');

      let processed = 0;
      for (const chunk of chunks) {
        try {
          const embedding = await this.createEmbedding(chunk.content);
          
          await this.db.collection('knowledge_base').insertOne({
            ...chunk,
            embedding,
            created_at: new Date()
          });

          processed++;
          process.stdout.write(`\r  Progress: ${processed}/${chunks.length}`);
          
          // Rate limiting - wait 100ms between requests
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`\n❌ Failed to process chunk: ${chunk.title}`, error.message);
        }
      }

      console.log(`\n✅ Successfully populated ${processed} knowledge items`);

      // Verify
      const count = await this.db.collection('knowledge_base').countDocuments();
      console.log(`📊 Total documents in knowledge_base: ${count}`);

      // Show sample
      const sample = await this.db.collection('knowledge_base')
        .find({ category: 'policy' })
        .limit(3)
        .toArray();
      
      console.log('\n📋 Sample policy entries:');
      sample.forEach(item => {
        console.log(`  - ${item.title}: ${item.content.substring(0, 80)}...`);
      });

    } catch (error) {
      console.error('❌ Population failed:', error);
      throw error;
    }
  }

  async close() {
    if (this.mongoClient) {
      await this.mongoClient.close();
      console.log('👋 Disconnected from MongoDB');
    }
  }
}

// Run the populator
async function main() {
  const populator = new KnowledgeBasePopulator();
  
  try {
    await populator.connect();
    await populator.populateFromJSON();
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  } finally {
    await populator.close();
  }
}

main();
