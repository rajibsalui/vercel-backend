import express from 'express';
import {generateSlug} from 'random-word-slugs';
import { ECSClient,RunTaskCommand } from '@aws-sdk/client-ecs';
import dotenv from 'dotenv';
import {Kafka} from 'kafkajs';
import cors from 'cors';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import {createClient} from '@clickhouse/client';
import { v4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { Server } from 'socket.io';


dotenv.config();

const app = express();
const PORT = 9000;

//const subscriber = new Redis(process.env.REDIS_URL);
const prisma = new PrismaClient({});
const client = createClient({
    host: process.env.CLICKHOUSE_HOST,
    database:'default',
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
});
const kafka = new Kafka({
    clientId: `api-server`,
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

const consumer = kafka.consumer({groupId: 'api-server-logs-consumer'});

const ecsClient = new ECSClient({ 
    region: 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    } 
});

io.on('connection', socket => {
    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', JSON.stringify({ log: `Subscribed to ${channel}` }))
    })
})

io.listen(9002, () => console.log('Socket Server 9002'))

app.use(express.json()); 
app.use(cors());

app.post('/project',async(req,res)=>{
    //const {name,gitUrl} = req.body;
    const schema = z.object({
        name: z.string(),
        gitUrl: z.string()
    });
   const safeParseResult = schema.safeParse(req.body);
   if(safeParseResult.error){
       return res.status(400).json({error:safeParseResult.error.errors});
}
   const {name,gitUrl} = safeParseResult.data;
   const project = await prisma.project.create({
         data:{
              name,
              gitUrl,
              subDomain:generateSlug()
         }
    });
    return res.json({status: 'success',data:{project}});
});

app.post('/deploy',async(req,res)=>{
    const {projectId} = req.body;
    const project = await prisma.project.findUnique({
        where:{
            id:projectId
        }
    });
    if(!project){
        return res.status(404).json({error:'Project not found'});
    }
    //check there is no running deployment for this project
    const deployment = await prisma.deployment.create({
        data:{
            projectId:{
                connect:{
                    id:projectId
                }
            },
            status:'QUEUED'
        }
    });

    //spin the container

    const command = new RunTaskCommand({
        cluster: process.env.CLUSTER_NAME,
        taskDefinition: process.env.TASK_DEFINITION,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                subnets: [process.env.SUBNET_ID1, process.env.SUBNET_ID2, process.env.SUBNET_ID3],
                securityGroups: [process.env.SECURITY_GROUP_ID],
                assignPublicIp: 'ENABLED'
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: 'builder-image',
                    environment: [
                        {
                            name: 'GIT_REPOSITORY_URL',
                            value: project.gitUrl
                        },
                        {
                            name: 'PROJECT_ID',
                            value: projectId
                        },
                        {
                            name:'DEPLOYMENT_ID',
                            value: deployment.id
                        }
                    ]
                }
            ]
        }
    });

    await ecsClient.send(command);

    return res.json({status:'queued',data:{deployment:deployment.id}});
})

app.get('/logs/:id', async (req, res) => {
    const id = req.params.id;
    const logs = await client.query({
        query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id:String}`,
        query_params: {
            deployment_id: id
        },
        format: 'JSONEachRow'
    })

    const rawLogs = await logs.json()

    return res.json({ logs: rawLogs })
})

async function initkafkaConsumer(){
    await consumer.connect();
    await consumer.subscribe({topic:'container-logs'});
    await consumer.run({
        autoCommit: false,
        eachBatch:async({batch,heartbeat,commitOffsetsIfNecessary,resolveOffset})=>{
            const messages = batch.messages
            console.log(messages);
            for (let message of messages){
                const stringMessage = JSON.parse(message.value.toString());
                const {PROJECT_ID,DEPLOYMENT_ID,log} = stringMessage;
                const {query_id}=await client.insert({
                    table:'log_events',
                    values: [{event_id: v4(),project_id:PROJECT_ID,deployment_id:DEPLOYMENT_ID,log}],
                    format: 'JSONEachRow'
                });
                resolveOffset(message.offset);
                await commitOffsetsIfNecessary(message.offset);
                await heartbeat();
                
            }
        }
    });
}
initkafkaConsumer();

app.listen(PORT, () => {
    console.log(`API Server is running on port ${PORT}`);
  });