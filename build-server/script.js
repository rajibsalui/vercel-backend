import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import mime from 'mime-types';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Kafka } from 'kafkajs';



//const publisher = new Redis(process.env.REDIS_URL);


dotenv.config();  // Load environment variables

// Get the current file path and directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.PROJECT_ID) {
    console.error('Missing required environment variables!');
    process.exit(1);
}

const s3Client = new S3Client({
    region: 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID;

const kafka = new Kafka({
    clientId: `docker-build-server-${DEPLOYMENT_ID}`,
    brokers: [process.env.KAFKA_BROKER], 
    ssl: {
        ca: [fs.readFileSync(path.join(__dirname, 'kafka.pem'), 'utf-8')],
    },
    sasl: {
        username: process.env.KAFKA_USERNAME,
        password: process.env.KAFKA_PASSWORD,
        mechanism: 'plain'
    },
});

const producer = kafka.producer();


async function publishLog(log) {
    //publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify(log));
    await producer.send({topic: `container-logs`, messages: [{value: JSON.stringify(PROJECT_ID,DEPLOYMENT_ID,log)}]});
}


async function init() {
    await producer.connect();
    console.log('Executing');
    await publishLog({ message: 'Build started', status: 'in_progress' });
    const outDirPath = path.join(__dirname, 'output');

    const p = exec(`cd ${outDirPath} && npm install && npm run build`);

    p.stdout.on('data', async (data) => {
        console.log(data.toString());
       await publishLog({ message: data.toString(), status: 'in_progress' });
    });

    p.stderr.on('data', async(data) => {
        console.error('Error:', data.toString());
        await publishLog({ message: data.toString(), status: 'error' });
    });

    p.on('close', async (code) => {
        if (code !== 0) {
            console.error(`Process exited with code ${code}`);
            return;
        }
        console.log('Build completed');
        await publishLog({ message: 'Build completed', status: 'success' }); 

        const distFolderPath = path.join(__dirname, 'output', 'dist');
        
        // Walk through directories recursively
        const walkDir = (dir, fileList = []) => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                if (fs.lstatSync(filePath).isDirectory()) {
                    walkDir(filePath, fileList);
                } else {
                    fileList.push(filePath);
                }
            }
            return fileList;
        };

        const distFolderContents = walkDir(distFolderPath);
        await publishLog({ message: 'Uploading files', status: 'in_progress' });
        for (const filePath of distFolderContents) {
            console.log('Uploading', filePath);
            await publishLog({ message: `Uploading ${filePath}`, status: 'in_progress' });
            const command = new PutObjectCommand({
                Bucket: 'rajib-vercel-clone',
                Key: `__outputs/${PROJECT_ID}/${path.relative(distFolderPath, filePath)}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath) || 'application/octet-stream'  // Fallback for unknown types
            });

            try {
                await s3Client.send(command);
                console.log('Uploaded:', filePath);
                await publishLog({ message: `Uploaded ${filePath}`, status: 'in_progress'});
            } catch (err) {
                console.error(`Failed to upload ${filePath}:`, err);
            }
        }
        console.log('Files uploaded');
        await publishLog({ message: 'Files uploaded', status: 'success' });
        process.exit(0);
    });
}

init();
