const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs').promises;

/**
 * TenantManager - Manages multi-tenant configurations and data isolation
 * Allows the system to serve different business types (e-commerce, electricity, telecom, etc.)
 */
class TenantManager {
  constructor() {
    this.tenants = new Map(); // Cache of loaded tenant configs
    this.mongoClient = null;
    this.db = null;
  }

  async initialize(mongoUri) {
    try {
      this.mongoClient = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        family: 4
      });
      
      await this.mongoClient.connect();
      this.db = this.mongoClient.db('multi_tenant_rag');
      
      console.log('✅ TenantManager initialized');
      
      // Load all tenant configurations
      await this.loadAllTenants();
    } catch (error) {
      console.error('❌ TenantManager initialization failed:', error);
      throw error;
    }
  }

  /**
   * Load all tenant configurations from filesystem and database
   */
  async loadAllTenants() {
    try {
      const tenantsDir = path.join(__dirname, '../../tenants');
      
      // Check if tenants directory exists
      try {
        await fs.access(tenantsDir);
      } catch {
        console.log('⚠️ Tenants directory not found, creating...');
        await fs.mkdir(tenantsDir, { recursive: true });
        return;
      }
      
      const tenantFolders = await fs.readdir(tenantsDir);
      
      for (const folder of tenantFolders) {
        const configPath = path.join(tenantsDir, folder, 'config.json');
        
        try {
          const configData = await fs.readFile(configPath, 'utf-8');
          const config = JSON.parse(configData);
          
          // Load tenant actions if they exist
          const actionsPath = path.join(tenantsDir, folder, 'actions.js');
          let actions = null;
          try {
            actions = require(actionsPath);
          } catch {
            console.log(`⚠️ No actions.js found for tenant: ${folder}`);
          }
          
          // Store in cache
          this.tenants.set(config.tenantId, {
            config,
            actions,
            folder
          });
          
          console.log(`✅ Loaded tenant: ${config.displayName} (${config.tenantId})`);
        } catch (error) {
          console.error(`❌ Failed to load tenant ${folder}:`, error.message);
        }
      }
      
      console.log(`✅ Loaded ${this.tenants.size} tenants`);
    } catch (error) {
      console.error('❌ Failed to load tenants:', error);
    }
  }

  /**
   * Get tenant configuration by ID
   */
  getTenant(tenantId) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }
    return tenant;
  }

  /**
   * Get all available tenants
   */
  getAllTenants() {
    return Array.from(this.tenants.values()).map(t => ({
      tenantId: t.config.tenantId,
      displayName: t.config.displayName,
      businessType: t.config.businessType,
      industry: t.config.industry
    }));
  }

  /**
   * Get tenant-specific database collection
   */
  getCollection(tenantId, collectionType) {
    const tenant = this.getTenant(tenantId);
    const collectionName = tenant.config.database.collections[collectionType];
    
    if (!collectionName) {
      throw new Error(`Collection type '${collectionType}' not found for tenant ${tenantId}`);
    }
    
    return this.db.collection(collectionName);
  }

  /**
   * Get tenant-specific knowledge base collection
   */
  getKnowledgeCollection(tenantId) {
    return this.db.collection(`knowledge_${tenantId}`);
  }

  /**
   * Check if tenant has a specific feature enabled
   */
  hasFeature(tenantId, featureName) {
    const tenant = this.getTenant(tenantId);
    return tenant.config.features[featureName] === true;
  }

  /**
   * Get tenant-specific action handler
   */
  getActionHandler(tenantId, actionName) {
    const tenant = this.getTenant(tenantId);
    
    if (!tenant.actions || !tenant.actions[actionName]) {
      throw new Error(`Action '${actionName}' not found for tenant ${tenantId}`);
    }
    
    return tenant.actions[actionName];
  }

  /**
   * Validate if action is enabled for tenant
   */
  isActionEnabled(tenantId, actionName) {
    const tenant = this.getTenant(tenantId);
    const actionConfig = tenant.config.actions[actionName];
    
    return actionConfig && actionConfig.enabled === true;
  }

  /**
   * Get tenant intents for dynamic intent recognition
   */
  getTenantIntents(tenantId) {
    const tenant = this.getTenant(tenantId);
    return tenant.config.intents || [];
  }

  /**
   * Get tenant entities for dynamic entity extraction
   */
  getTenantEntities(tenantId) {
    const tenant = this.getTenant(tenantId);
    return {
      primary: tenant.config.entities.primary,
      secondary: tenant.config.entities.secondary || []
    };
  }

  /**
   * Create a new tenant (admin function)
   */
  async createTenant(tenantConfig) {
    try {
      // Validate config
      if (!tenantConfig.tenantId || !tenantConfig.businessType) {
        throw new Error('Invalid tenant config: tenantId and businessType required');
      }
      
      // Check if tenant already exists
      if (this.tenants.has(tenantConfig.tenantId)) {
        throw new Error(`Tenant already exists: ${tenantConfig.tenantId}`);
      }
      
      // Create tenant directory
      const tenantDir = path.join(__dirname, '../../tenants', tenantConfig.tenantId);
      await fs.mkdir(tenantDir, { recursive: true });
      
      // Save config
      const configPath = path.join(tenantDir, 'config.json');
      await fs.writeFile(configPath, JSON.stringify(tenantConfig, null, 2));
      
      // Create empty knowledge base
      const knowledgePath = path.join(tenantDir, 'knowledge.json');
      await fs.writeFile(knowledgePath, JSON.stringify({ policies: {}, faqs: [] }, null, 2));
      
      // Create empty intents file
      const intentsPath = path.join(tenantDir, 'intents.json');
      await fs.writeFile(intentsPath, JSON.stringify({ intents: [] }, null, 2));
      
      // Reload tenants
      await this.loadAllTenants();
      
      console.log(`✅ Created new tenant: ${tenantConfig.displayName}`);
      
      return { success: true, tenantId: tenantConfig.tenantId };
    } catch (error) {
      console.error('❌ Failed to create tenant:', error);
      throw error;
    }
  }

  /**
   * Get tenant-specific configuration for agent
   */
  getAgentConfig(tenantId) {
    const tenant = this.getTenant(tenantId);
    return {
      tenantId: tenant.config.tenantId,
      displayName: tenant.config.displayName,
      businessType: tenant.config.businessType,
      language: tenant.config.language,
      timezone: tenant.config.timezone,
      currency: tenant.config.currency,
      intents: tenant.config.intents,
      entities: tenant.config.entities,
      actions: tenant.config.actions,
      features: tenant.config.features,
      escalation: tenant.config.escalation || {}
    };
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.mongoClient) {
      await this.mongoClient.close();
      console.log('✅ TenantManager closed');
    }
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getInstance: () => {
    if (!instance) {
      instance = new TenantManager();
    }
    return instance;
  },
  TenantManager
};
