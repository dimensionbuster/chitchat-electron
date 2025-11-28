import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

import { scanItems } from './dynamodb.js';

// Minimal local types to avoid external type dependencies
type HttpV2WebsocketEvent = {
  body: string | null;
  requestContext: {
    apiId: string;
    stage: string;
    routeKey: '$connect' | '$disconnect' | '$default' | string;
    connectionId: string;
  };
};
type HttpV2Response = { statusCode: number; body?: string };

const { AWS_REGION, TOPICS_TABLE } = process.env;

const dynamoDb = new DynamoDBClient({ region: AWS_REGION });

// Message structure and protocol flow taken from y-webrtc/bin/server.js
interface YWebRtcSubscriptionMessage {
  type: 'subscribe' | 'unsubscribe';
  topics?: string[];
}
interface YWebRtcPingMessage {
  type: 'ping';
}
interface YWebRtcPublishMessage {
  type: 'publish';
  topic?: string;
  [k: string]: any;
}

async function subscribe(topic: string, connectionId: string) {
  try {
    return await dynamoDb.send(
      new UpdateItemCommand({
        TableName: TOPICS_TABLE!,
        Key: { name: { S: topic } },
        UpdateExpression: 'ADD receivers :r',
        ExpressionAttributeValues: {
          ':r': { SS: [connectionId] },
        },
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Cannot update topic ${topic}: ${msg}`);
  }
}

async function unsubscribe(topic: string, connectionId: string) {
  try {
    return await dynamoDb.send(
      new UpdateItemCommand({
        TableName: TOPICS_TABLE!,
        Key: { name: { S: topic } },
        UpdateExpression: 'DELETE receivers :r',
        ExpressionAttributeValues: {
          ':r': { SS: [connectionId] },
        },
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Cannot update topic ${topic}: ${msg}`);
  }
}

async function getReceivers(topic: string): Promise<string[]> {
  try {
    const { Item: item } = await dynamoDb.send(
      new GetItemCommand({
        TableName: TOPICS_TABLE!,
        Key: { name: { S: topic } },
      }),
    );
    // Item is a map of AttributeValue; safely access receivers as a String Set
    const receivers = (item as any)?.receivers?.SS ?? [];
    return receivers as string[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Cannot get topic ${topic}: ${msg}`);
    return [];
  }
}

async function handleYWebRtcMessage(
  connectionId: string,
  message:
    | YWebRtcSubscriptionMessage
    | YWebRtcPublishMessage
    | YWebRtcPingMessage,
  send: (receiver: string, message: any) => Promise<void>,
) {
  const promises: Array<Promise<unknown>> = [];

  if (message && message.type) {
    switch (message.type) {
      case 'subscribe':
        (message.topics || []).forEach(topic => {
          promises.push(subscribe(topic, connectionId));
        });
        break;
      case 'unsubscribe':
        (message.topics || []).forEach(topic => {
          promises.push(unsubscribe(topic, connectionId));
        });
        break;
      case 'publish':
        if (message.topic) {
          const receivers = await getReceivers(message.topic);
          receivers.forEach(receiver => {
            promises.push(send(receiver, message));
          });
        }
        break;
      case 'ping':
        promises.push(send(connectionId, { type: 'pong' }));
        break;
    }
  }

  await Promise.all(promises);
}

function handleConnect(connectionId: string) {
  // Nothing to do
  console.log(`Connected: ${connectionId}`);
}

async function handleDisconnect(connectionId: string) {
  console.log(`Disconnected: ${connectionId}`);
  // Remove the connection from all topics
  // This is quite expensive, as we need to go through all topics in the table
  const promises: Array<Promise<unknown>> = [];
  for await (const item of scanItems(dynamoDb, TOPICS_TABLE)) {
    const receivers = item.receivers?.SS ?? [];
    if (receivers.includes(connectionId)) {
      const name = item.name?.S;
      if (name) {
        promises.push(unsubscribe(name, connectionId));
      }
    }
  }

  await Promise.all(promises);
}

export async function handler(
  event: HttpV2WebsocketEvent,
): Promise<HttpV2Response> {
  if (!TOPICS_TABLE) {
    return { statusCode: 502, body: 'Not configured' };
  }

  // The AWS "simple chat" example uses event.requestContext.domainName/...stage, but that doesn't work with custom domain
  // names. It also doesn't matter, this is anyways an internal (AWS->AWS) call.
  const apigwManagementApi = new ApiGatewayManagementApiClient({
    region: AWS_REGION,
    endpoint: `https://${event.requestContext.apiId}.execute-api.${AWS_REGION}.amazonaws.com/${event.requestContext.stage}`,
  });
  const send = async (connectionId: string, message: any) => {
    try {
      await apigwManagementApi.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify(message)),
        }),
      );
    } catch (err) {
      const anyErr = err as any;
      const status = anyErr?.$metadata?.httpStatusCode ?? anyErr?.statusCode;
      if (status === 410) {
        console.log(`Found stale connection, deleting ${connectionId}`);
        await handleDisconnect(connectionId);
      } else {
        // Log, but otherwise ignore: There's not much we can do, really.
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`Error when sending to ${connectionId}: ${msg}`);
      }
    }
  };

  try {
    switch (event.requestContext.routeKey) {
      case '$connect':
        handleConnect(event.requestContext.connectionId);
        break;
      case '$disconnect':
        await handleDisconnect(event.requestContext.connectionId);
        break;
      case '$default':
        await handleYWebRtcMessage(
          event.requestContext.connectionId,
          JSON.parse(event.body ?? '{}'),
          send,
        );
        break;
    }

    return { statusCode: 200 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Error ${event.requestContext.connectionId}`, err);
    return { statusCode: 500, body: msg };
  }
}