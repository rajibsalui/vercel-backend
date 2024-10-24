import express from 'express';
import httpProxy from 'http-proxy';

const app = express();
const PORT = 8000;
const BASE_PATH = 'https://rajib-vercel-clone.s3.ap-south-1.amazonaws.com/__outputs';

const proxy = httpProxy.createProxy();

app.use((req, res) => {
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];

    const resolveTo = `${BASE_PATH}/${subdomain}`;

    return proxy.web(req, res, { target: resolveTo, changeOrigin: true });
});

proxy.on('proxyReq', (proxyReq, req, res) => {
    const url = req.url;
    if (url === '/') {
        proxyReq.path += 'index.html';
    }
});

app.listen(PORT, () => {
  console.log(`Reverse proxy is running on port ${PORT}`);
});