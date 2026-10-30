import serverless from 'serverless-http';
import { app } from '../../src/server.js';

const serverlessHandler = serverless(app);

export const handler = async (event, context) => {
  try {
    return await serverlessHandler(event, context);
  } catch (err) {
    console.error('[Netlify Function API Error]:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
