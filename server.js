import express from "express";
import { Server } from "socket.io";
import http from "http";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

io.on("connection", (socket) => {
  console.log("✅ A user connected");

  // Send welcome message on connect
  socket.emit("receive_message", {
    text: "Hello! How can I help you today?",
    sender: "bot",
    timestamp: new Date().toISOString(),
  });

  // Handle typing updates
  socket.on("typing_status", (message) => {
    if (message) {
      console.log("✍️ User is typing:", message);
    }
  });

  socket.on("send_message", (msg) => {
    console.log("📩 Message received:", msg);

    // Emit user's message to themselves (with status: delivered)
    socket.emit("receive_message", {
      text: msg,
      sender: "user",
      timestamp: new Date().toISOString(),
      status: "delivered",
    });

    // Start bot typing
    setTimeout(() => {
      socket.emit("typing_status", true);

      setTimeout(() => {
        socket.emit("typing_status", false);

        const replies = [
          "Thanks for your message! How can I assist you further?",
          "I'm here to help. What do you need?",
          "Could you provide more details about your question?",
          "One of our team members will respond shortly.",
          "We appreciate your message. How may we help?",
        ];

        const randomReply = replies[Math.floor(Math.random() * replies.length)];

        // Reply from bot
        socket.emit("receive_message", {
          text: randomReply,
          sender: "bot",
          timestamp: new Date().toISOString(),
          status: "received",
        });
      }, 3000);
    }, 1000);
  });

  socket.on("send_message_with_steps", (msg) => {
    console.log("📩 Message received:", msg);
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected");
  });
});

app.get("/", (req, res) => {
  res.send("Chat Server is running");
});

server.listen(3001, () => {
  console.log("🚀 Server running on port 3001");
});
