import serverless from 'serverless-http';

let serverlessHandler = null;
let initError = null;

async function getHandler() {
  if (serverlessHandler) return serverlessHandler;
  if (initError) throw initError;
  try {
    const { app } = await import('../../src/server.js');
    serverlessHandler = serverless(app);
    return serverlessHandler;
  } catch (err) {
    initError = err;
    throw err;
  }
}

export const handler = async (event, context) => {
  try {
    const fn = await getHandler();
    return await fn(event, context);
  } catch (err) {
    console.error('[Netlify Function API Error]:', err);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        error: `Serverless Initialization Error: ${err.message}`,
        stack: err.stack,
      }),
    };
  }
};
