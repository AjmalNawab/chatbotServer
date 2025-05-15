// import express from "express";
// import { Server } from "socket.io";
// import http from "http";

// const app = express();
// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: {
//     origin: "*",
//   },
// });

// io.on("connection", (socket) => {
//   console.log("✅ A user connected");

//   // Send welcome message on connect
//   socket.emit("receive_message", {
//     text: "Hello! How can I help you today?",
//     sender: "bot",
//     timestamp: new Date().toISOString(),
//   });

//   // Handle typing updates
//   socket.on("typing_status", (message) => {
//     if (message) {
//       console.log("✍️ User is typing:", message);
//     }
//   });

//   socket.on("send_message", (msg) => {
//     console.log("📩 Message received:", msg);

//     // Emit user's message to themselves (with status: delivered)
//     socket.emit("receive_message", {
//       text: msg,
//       sender: "user",
//       timestamp: new Date().toISOString(),
//       status: "delivered",
//     });

//     // Start bot typing
//     setTimeout(() => {
//       socket.emit("typing_status", true);

//       setTimeout(() => {
//         socket.emit("typing_status", false);

//         const replies = [
//           "Thanks for your message! How can I assist you further?",
//           "I'm here to help. What do you need?",
//           "Could you provide more details about your question?",
//           "One of our team members will respond shortly.",
//           "We appreciate your message. How may we help?",
//         ];

//         const randomReply = replies[Math.floor(Math.random() * replies.length)];

//         // Reply from bot
//         socket.emit("receive_message", {
//           text: randomReply,
//           sender: "bot",
//           timestamp: new Date().toISOString(),
//           status: "received",
//         });
//       }, 3000);
//     }, 1000);
//   });

//   socket.on("send_message_with_steps", (msg) => {
//     console.log("📩 Message received:", msg);
//   });

//   socket.on("disconnect", () => {
//     console.log("❌ User disconnected");
//   });
// });

// app.get("/", (req, res) => {
//   res.send("Chat Server is running");
// });

// server.listen(3001, () => {
//   console.log("🚀 Server running on port 3001");
// });
// server.js
import express from "express";
import { Server } from "socket.io";
import http from "http";
import dotenv from "dotenv";
import axios from "axios";

// Load environment variables
dotenv.config();

// Express and Socket.IO setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// OpenRouter settings
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const HEADERS = {
  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  "HTTP-Referer": "https://sales-chatbot.netlify.app/", // Update to your frontend domain in production
  "Content-Type": "application/json",
};

// Handle socket connections
io.on("connection", (socket) => {
  console.log("✅ A user connected");

  socket.emit("receive_message", {
    text: "Hello! How can I help you today?",
    sender: "bot",
    timestamp: new Date().toISOString(),
  });

  socket.on("typing_status", (message) => {
    if (message) {
      console.log("✍️ User is typing:", message);
    }
  });

  socket.on("send_message", async (msg) => {
    console.log("📩 Message received:", msg);

    socket.emit("receive_message", {
      text: msg,
      sender: "user",
      timestamp: new Date().toISOString(),
      status: "delivered",
    });

    try {
      socket.emit("typing_status", true);

      const response = await axios.post(
        OPENROUTER_URL,
        {
          model: "openai/gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: "Reply shortly and helpfully as a chatbot.",
            },
            { role: "user", content: msg },
          ],
          max_tokens: 50,
        },
        { headers: HEADERS }
      );

      const reply = response.data.choices[0].message.content;

      setTimeout(() => {
        socket.emit("typing_status", false);
        socket.emit("receive_message", {
          text: reply,
          sender: "bot",
          timestamp: new Date().toISOString(),
          status: "received",
        });
      }, 1500);
    } catch (err) {
      console.error("❌ OpenRouter Error:", err.message);
      socket.emit("receive_message", {
        text: "Sorry, I couldn't process that right now.",
        sender: "bot",
        timestamp: new Date().toISOString(),
        status: "error",
      });
    }
  });

  socket.on("send_message_with_steps", async (msg) => {
    console.log("📩 Message received with steps:", msg);

    try {
      socket.emit("typing_status", true);

      const response = await axios.post(
        OPENROUTER_URL,
        {
          model: "openai/gpt-3.5-turbo",
          messages: [
            { role: "system", content: "Reply with steps as a chatbot." },
            { role: "user", content: msg },
          ],
          max_tokens: 200,
        },
        { headers: HEADERS }
      );

      const reply = response.data.choices[0].message.content;

      setTimeout(() => {
        socket.emit("typing_status", false);
        socket.emit("receive_message", {
          text: reply,
          sender: "bot",
          timestamp: new Date().toISOString(),
          status: "received",
        });
      }, 1500);
    } catch (err) {
      console.error("❌ OpenRouter Error:", err.message);
      socket.emit("receive_message", {
        text: "Sorry, I couldn't process that right now.",
        sender: "bot",
        timestamp: new Date().toISOString(),
        status: "error",
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected");
  });
});

// Test route
app.get("/", (req, res) => {
  res.send("Chat Server is running");
});

// Start server
server.listen(3001, () => {
  console.log("🚀 Server running on port 3001");
});
