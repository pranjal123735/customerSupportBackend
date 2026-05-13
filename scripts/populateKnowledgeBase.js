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
        // Shipping policy
        if (knowledgeData.policies.shipping) {
          const shipping = knowledgeData.policies.shipping;
          chunks.push({
            category: 'policy',
            title: 'Shipping Policy',
            content: `Shipping Policy: Standard shipping takes ${shipping.standard_shipping.time} and costs ${shipping.standard_shipping.cost} (free over ${shipping.standard_shipping.free_threshold}). Express shipping: ${shipping.express_shipping.time} for ${shipping.express_shipping.cost}. Overnight: ${shipping.overnight_shipping.time} for ${shipping.overnight_shipping.cost}. International: ${shipping.international_shipping.time}. ${shipping.tracking}. Delivery options: ${shipping.delivery_options.join(', ')}.`
          });
        }

        // Return policy - CRITICAL
        if (knowledgeData.policies.return) {
          const returnPolicy = knowledgeData.policies.return;
          chunks.push({
            category: 'policy',
            title: 'Return Policy',
            content: `Return Policy: ${returnPolicy.return_window} return window from delivery date. Items must be ${returnPolicy.condition}. Free returns: ${returnPolicy.free_returns}. Return shipping label provided via email within 24 hours. Refund processing: ${returnPolicy.refund_processing_time}. Non-returnable items: ${returnPolicy.non_returnable_items.join(', ')}. Damaged/defective: ${returnPolicy.damaged_or_defective.policy}. Wrong item: ${returnPolicy.wrong_item.policy}.`
          });
        }

        // Refund policy - CRITICAL
        if (knowledgeData.policies.refund) {
          const refund = knowledgeData.policies.refund;
          chunks.push({
            category: 'policy',
            title: 'Refund Policy',
            content: `Refund Policy: Full refunds for: ${refund.full_refund_conditions.join(', ')}. Partial refunds for: ${refund.partial_refund_conditions.join(', ')}. No refunds for: ${refund.no_refund_conditions.join(', ')}. Refund method: ${refund.refund_method}. Processing time: ${refund.refund_processing_time}. Store credit option: ${refund.store_credit_option}.`
          });
        }

        // Cancellation policy
        if (knowledgeData.policies.cancellation) {
          const cancel = knowledgeData.policies.cancellation;
          chunks.push({
            category: 'policy',
            title: 'Cancellation Policy',
            content: `Cancellation Policy: Before shipment: ${cancel.before_shipment.policy}. How to cancel: ${cancel.before_shipment.how_to}. After shipment: ${cancel.after_shipment.policy}. Exception: ${cancel.after_shipment.exception}. Processing time: ${cancel.processing_time}. Refund time: ${cancel.refund_time}.`
          });
        }

        // Payment policy
        if (knowledgeData.policies.payment) {
          const payment = knowledgeData.policies.payment;
          chunks.push({
            category: 'policy',
            title: 'Payment Policy',
            content: `Payment Policy: Accepted methods: ${payment.accepted_methods.join(', ')}. Security: ${payment.payment_security}. Processing: ${payment.payment_processing}. Installment plans available for orders over $100: ${payment.installment_plans.options.join(', ')}. Currency: ${payment.currency}. Price match: ${payment.price_match.policy}.`
          });
        }

        // Warranty policy
        if (knowledgeData.policies.warranty) {
          const warranty = knowledgeData.policies.warranty;
          chunks.push({
            category: 'policy',
            title: 'Warranty Policy',
            content: `Warranty Policy: Manufacturer warranty: ${warranty.manufacturer_warranty}. Extended warranty available: ${warranty.extended_warranty.available}, costs ${warranty.extended_warranty.cost}, coverage up to ${warranty.extended_warranty.coverage}. Includes: ${warranty.extended_warranty.includes.join(', ')}. Claims: ${warranty.warranty_claims}.`
          });
        }

        // Price protection
        if (knowledgeData.policies.price_protection) {
          const priceProtection = knowledgeData.policies.price_protection;
          chunks.push({
            category: 'policy',
            title: 'Price Protection Policy',
            content: `Price Protection: ${priceProtection.policy}. How to claim: ${priceProtection.how_to_claim}. Exclusions: ${priceProtection.exclusions.join(', ')}.`
          });
        }
      }

      // Process product categories
      if (knowledgeData.product_categories) {
        knowledgeData.product_categories.forEach(category => {
          chunks.push({
            category: 'products',
            title: `${category.name} Category`,
            content: `${category.name}: Subcategories include ${(category.subcategories || []).join(', ')}. Popular brands: ${(category.popular_brands || []).join(', ')}. Warranty: ${category.warranty || 'N/A'}. Return window: ${category.return_window || 'N/A'}. ${category.special_notes || ''}.`
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

      // Process customer service
      if (knowledgeData.customer_service) {
        const cs = knowledgeData.customer_service;
        chunks.push({
          category: 'support',
          title: 'Customer Service Contact Methods',
          content: `Customer Service: Phone: ${cs.contact_methods?.phone?.number || 'N/A'} (${cs.contact_methods?.phone?.hours || 'N/A'}). Email: ${cs.contact_methods?.email?.address || 'N/A'} (response within ${cs.contact_methods?.email?.response_time || 'N/A'}). Live chat: ${cs.contact_methods?.live_chat?.availability || 'N/A'}. WhatsApp: ${cs.contact_methods?.whatsapp?.number || 'N/A'} (24/7). Languages: ${(cs.contact_methods?.phone?.languages || []).join(', ')}.`
        });
      }

      // Process loyalty program
      if (knowledgeData.loyalty_program) {
        const loyalty = knowledgeData.loyalty_program;
        chunks.push({
          category: 'loyalty',
          title: 'Loyalty Program',
          content: `${loyalty.name}: Free enrollment. Earn ${loyalty.earning?.purchases || ''}, ${loyalty.earning?.reviews || ''}, ${loyalty.earning?.referrals || ''}, ${loyalty.earning?.birthday || ''}. Redemption: ${loyalty.redemption?.rate || ''}, minimum ${loyalty.redemption?.minimum || ''}. Tiers: ${(loyalty.tiers || []).map(t => `${t.name} (${t.requirement}): ${(t.benefits || []).join(', ')}`).join(' | ')}.`
        });
      }

      // Process promotions
      if (knowledgeData.promotions) {
        const promos = knowledgeData.promotions;
        const currentOffers = (promos.current_offers || []).map(o => 
          `${o.code}: ${o.description} (min order: ${o.minimum_order}, valid until: ${o.valid_until})`
        ).join(' | ');
        
        chunks.push({
          category: 'promotions',
          title: 'Current Promotions and Discounts',
          content: `Current Offers: ${currentOffers}. Seasonal sales: ${Object.entries(promos.seasonal_sales || {}).map(([k,v]) => `${k}: ${v}`).join(', ')}. Flash deals: ${promos.flash_deals || 'N/A'}. Student discount: ${promos.student_discount || 'N/A'}. Military discount: ${promos.military_discount || 'N/A'}. Senior discount: ${promos.senior_discount || 'N/A'}.`
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
