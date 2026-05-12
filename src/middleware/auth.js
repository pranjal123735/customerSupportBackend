// Simple authentication middleware for API endpoints
const auth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  // In production, use proper authentication
  if (process.env.NODE_ENV === 'production' && !apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  
  // For development, allow all requests
  next();
};

module.exports = auth;