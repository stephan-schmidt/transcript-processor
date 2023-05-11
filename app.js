
 fs = require('fs').promises;
const http = require('http');
const Bottleneck = require('bottleneck');
const { Configuration, OpenAIApi } = require("openai");
const express = require('express');
const multer = require('multer');

const WebSocket = require('ws');
const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const apiLimiter = new Bottleneck({ minTime: 1000, maxConcurrent: 1 });

const app = express();
const server = http.createServer(app);
const upload = multer({ dest: 'uploads/' });

const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

app.post('/process', upload.single('file'), async (req, res) => {

  

  // Update the Configuration object with the new API Key


  const inputFormat = req.body.format;
  const chatData = await splitBySpeaker(req.file.path, inputFormat);

  res.sendStatus(200);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      saveChatDataToCsv(chatData, client);
    }
  });

  await fs.unlink(req.file.path);
});

server.listen(3000, () => {
  console.log('App listening on port 3000');
});




async function splitBySpeaker(input_file, inputFormat) {
  const text = await fs.readFile(input_file, 'utf-8');
  let speakerRegex;

  switch (inputFormat) {
    case 'zoom_transcript':
      speakerRegex = /^@(\d{1,2}:\d{2}) - (.*?)\n(.*)$/gm;
      break;
    case 'otter_ai_transcript':
      speakerRegex = /^(Speaker \d+|Unknown Speaker)\s+(\d{1,2}:\d{2})\s*\n(.*)$/gm;
      break;
    case 'wudpecker_transcript':
      speakerRegex = /^.*\n(.*?)\n(\d{1,2}:\d{2})\n(.*)$/gm;
      break;
    case 'zoom_chat_transcript':
      speakerRegex = /^(\d{1,2}:\d{2}:\d{2}) From (.*?) to .*?:\n\s*(.*)$/gm;
      break;
      case 'zoom_webvtt_transcript':
        speakerRegex = /^\d+\n(\d{2}:\d{2}:\d{2}\.\d{3}) --> \d{2}:\d{2}:\d{2}\.\d{3}\n(.*?): (.*)$/gm;
        break;
    default:
      throw new Error('Invalid input format');
  }
  

  const chatData = [];

  let matches;
  while ((matches = speakerRegex.exec(text)) !== null) {
    let speaker, timestamp, content;

    if (inputFormat === 'zoom_webvtt_transcript') {
      timestamp = matches[1].trim();
      speaker = matches[2].trim().replace(/[,()]/g, '').replace(/[^\w\s-]/g, '');
    } else if (inputFormat === 'zoom_chat_transcript' || inputFormat === 'zoom_transcript') {
      speaker = matches[2].trim().replace(/[,()]/g, '').replace(/[^\w\s-]/g, '');
      timestamp = matches[1].trim();
    } else {
      speaker = matches[1].trim().replace(/[,()]/g, '').replace(/[^\w\s-]/g, '');
      timestamp = matches[2].trim();
    }

    content = matches[3].trim();
    chatData.push({ timestamp, speaker, content });
  }

  return chatData;
}


function splitContentIntoChunks(content, maxTokens) {
  const words = content.split(' ');
  const chunks = [];
  let chunk = '';

  for (const word of words) {
    if (chunk.length + word.length + 1 <= maxTokens) {
      chunk += (chunk ? ' ' : '') + word;
    } else {
      chunks.push(chunk);
      chunk = word;
    }
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return chunks;
}

async function summarizeChunk(chunk, retries = 3) {
  const prompt = `Please summarize what the person expressed in about 300 words:\n\n${chunk}`;
  const maxTokens = 300;

  try {
    return await apiLimiter.schedule(async () => {
      const openai = new OpenAIApi(configuration);

      console.log(`Sending prompt: ${prompt}`); // Log the prompt before sending the request

      const response = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that summarizes text.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: maxTokens,
        n: 1,
        stop: null,
        temperature: 0.7,
      });

      console.log(`Received response: ${response.data.choices[0].message.content.trim()}`); // Log the received response

      return response.data.choices[0].message.content.trim();
    });
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying, ${retries} attempts remaining...`);
      await new Promise((resolve) => setTimeout(resolve, 2 ** (4 - retries) * 1000));
      return await summarizeChunk(chunk, retries - 1);
    } else {
      throw error;
    }
  }
}




async function saveChatDataToCsv(chatData, ws) {
  const maxTokens = 4096;

  // Group content by speaker
  const groupedContent = {};
  chatData.forEach(({ speaker, content }) => {
    if (!groupedContent[speaker]) {
      groupedContent[speaker] = '';
    }
    groupedContent[speaker] += ' ' + content;
  });

  // Summarize content for each speaker
  const summarizedData = [];
  for (const [speaker, content] of Object.entries(groupedContent)) {
    const chunks = splitContentIntoChunks(content, maxTokens);
    const summarizedChunks = await Promise.all(chunks.map(chunk => summarizeChunk(chunk)));
    const summarizedContent = await summarizeChunk(summarizedChunks.join(' '));

    const summary = { speaker, content: summarizedContent };
    ws.send(JSON.stringify(summary));
  }
}