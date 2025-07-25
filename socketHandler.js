import Conversation from "../models/Conversation.js";
import Visitor from "../models/Visitor.js";
import CSR from "../models/CSRs.js";
import { chatbot } from "../service/openRouter.js";
import dotenv from "dotenv";
import axios from "axios";
import BanRegion from "../models/BanRegion.js";
dotenv.config();

const pendingApprovals = new Map();
const csrSockets = new Map(); // Track CSR sockets for reconnection
const userSockets = new Map(); // Track user sockets by userId to maintain active connections
// FIX 1: Add a dedicated map to track browsing visitors separately from userSockets
const browsingVisitors = new Map(); // Track browsing visitors separately

// FIX 3: Add locks to prevent race conditions in socket tracking
const socketLocks = new Map(); // Track locks per userId to prevent race conditions

// FIX 3: Helper function to acquire lock for userId operations
const withLock = async (userId, operation) => {
  // Create a simple lock mechanism using promises
  if (socketLocks.has(userId)) {
    // Wait for existing operation to complete
    await socketLocks.get(userId);
  }
  
  let resolveLock;
  const lockPromise = new Promise(resolve => {
    resolveLock = resolve;
  });
  
  socketLocks.set(userId, lockPromise);
  
  try {
    const result = await operation();
    return result;
  } finally {
    // Release the lock
    socketLocks.delete(userId);
    resolveLock();
  }
};

// FIX 3: Improved socket tracking functions with race condition protection
const addUserSocket = async (userId, socketId) => {
  return withLock(userId, async () => {
    if (!userSockets.has(userId)) {
      userSockets.set(userId, []);
    }
    
    const socketArray = userSockets.get(userId);
    if (!socketArray.includes(socketId)) {
      socketArray.push(socketId);
      console.log(
        `🔗 [USER SOCKET TRACKING] Added socket ${socketId} for user ${userId}. Total: ${socketArray.length}`
      );
    }
    
    return socketArray.length;
  });
};

const removeUserSocket = async (userId, socketId) => {
  return withLock(userId, async () => {
    if (!userSockets.has(userId)) {
      return 0;
    }
    
    const socketArray = userSockets.get(userId);
    const socketIndex = socketArray.indexOf(socketId);
    
    if (socketIndex !== -1) {
      socketArray.splice(socketIndex, 1);
      console.log(
        `🔌 [USER SOCKET TRACKING] Removed socket ${socketId} for user ${userId}. Remaining: ${socketArray.length}`
      );
      
      if (socketArray.length === 0) {
        userSockets.delete(userId);
        console.log(`🧹 [USER SOCKET TRACKING] Cleaned up empty socket array for user ${userId}`);
      }
    }
    
    return socketArray.length;
  });
};

const getUserSocketCount = (userId) => {
  const sockets = userSockets.get(userId);
  return sockets ? sockets.length : 0;
};

// FIX 2: Enhanced getLocationFromCoordinates with retry mechanism and better error handling
const getLocationFromCoordinatesWithRetry = async (latitude, longitude, retries = 3) => {
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!latitude || !longitude) {
        console.log("❌ [LOCATION ERROR] Missing latitude or longitude");
        return {
          country: "Unknown",
          city: "Unknown",
          region: "Unknown",
        };
      }

      // Using Nominatim for reverse geocoding (free and open-source)
      // Add a unique user agent and email parameter to comply with Nominatim usage policy
      const response = await axios.get(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=1&accept-language=en`,
        {
          headers: {
            "User-Agent": "BoxWebsite/1.0",
            "Accept-Language": "en",
          },
          timeout: 5000, // 5 second timeout
        }
      );

      const data = response.data;

      if (!data || !data.address) {
        console.log(
          `❌ [LOCATION ERROR] Invalid response from geocoding service`
        );
        return {
          country: "Unknown",
          city: "Unknown",
          region: "Unknown",
        };
      }

      return {
        country: data.address?.country || "Unknown",
        city:
          data.address?.city ||
          data.address?.town ||
          data.address?.village ||
          data.address?.hamlet ||
          "Unknown",
        region: data.address?.state || data.address?.county || "Unknown",
      };
    } catch (error) {
      console.error(
        `❌ [LOCATION ERROR] Attempt ${attempt}/${retries} failed:`,
        error.message
      );
      
      // Check for specific error types
      if (error.code === 'ECONNABORTED') {
        console.error("❌ [LOCATION ERROR] Request timeout");
      } else if (error.response) {
        console.error(
          "❌ [LOCATION ERROR] Response status:",
          error.response.status
        );
        console.error(
          "❌ [LOCATION ERROR] Response data:",
          JSON.stringify(error.response.data, null, 2)
        );
        
        // Don't retry for 4xx errors (client errors)
        if (error.response.status >= 400 && error.response.status < 500) {
          console.error("❌ [LOCATION ERROR] Client error, not retrying");
          break;
        }
      } else if (error.request) {
        console.error("❌ [LOCATION ERROR] No response received");
      }
      
      // If this is the last attempt, return fallback
      if (attempt === retries) {
        console.error("❌ [LOCATION ERROR] All retry attempts failed, using fallback");
        return {
          country: "Unknown",
          city: "Unknown",
          region: "Unknown",
        };
      }
      
      // Exponential backoff delay before retry
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`⏳ [LOCATION RETRY] Waiting ${delayMs}ms before retry ${attempt + 1}`);
      await delay(delayMs);
    }
  }
  
  // Fallback return (should not reach here)
  return {
    country: "Unknown",
    city: "Unknown",
    region: "Unknown",
  };
};

// Update the function reference to use the new retry version
const getLocationFromCoordinates = getLocationFromCoordinatesWithRetry;

// Immediately test with the coordinates provided in the example
(async () => {
  try {
    const testLocation = await getLocationFromCoordinates(
      34.00426808268424,
      71.50405614269818
    );
  } catch (error) {
    console.error("🧪 [TEST] Test geocoding failed:", error.message);
  }
})();

// FIX 1: Helper function to emit browsing visitors to specific CSR or all CSRs
const emitBrowsingVisitorsToCSR = (io, targetSocket = null) => {
  const browsingVisitorsList = Array.from(browsingVisitors.values());
  console.log(`📡 [BROWSING EMIT] Emitting ${browsingVisitorsList.length} browsing visitors`);
  
  if (targetSocket) {
    // Emit to specific CSR socket
    targetSocket.emit("browsing_visitors_list", browsingVisitorsList);
    browsingVisitorsList.forEach((visitor) => {
      targetSocket.emit("new_visitor_browsing", {
        userId: visitor.userId,
        timestamp: visitor.timestamp || new Date().toISOString(),
        socketId: visitor.socketId || "",
        visitorData: visitor,
      });
    });
  } else {
    // Emit to all CSRs
    io.to("csr_room").emit("browsing_visitors_list", browsingVisitorsList);
    browsingVisitorsList.forEach((visitor) => {
      io.to("csr_room").emit("new_visitor_browsing", {
        userId: visitor.userId,
        timestamp: visitor.timestamp || new Date().toISOString(),
        socketId: visitor.socketId || "",
        visitorData: visitor,
      });
    });
  }
};

// Function to create a new visitor
const createVisitor = async (io, socket, additionalInfo = {}) => {
  try {
    const userId = socket.handshake.query.userId;
    const initialInfo = socket.handshake.query.initialInfo
      ? JSON.parse(socket.handshake.query.initialInfo)
      : {};

    // Get the real client IP (handles both IPv4 and IPv6)
    const ipAddress =
      socket.handshake.headers["x-forwarded-for"] ||
      socket.handshake.address ||
      socket.conn.remoteAddress ||
      "0.0.0.0";
    //added new
    const cleanIp = ipAddress.replace(/^::ffff:/, "");

    if (!userId) {
      console.log(
        "⚠️ [VISITOR WARNING] No userId provided, skipping visitor creation"
      );
      return null;
    }

    // Get location data from coordinates if available
    let locationData = {
      country: "Unknown",
      city: "Unknown",
      region: "Unknown",
    };

    // Extract coordinates from initialInfo if available
    let coordinates = null;

    if (initialInfo.location && typeof initialInfo.location === "string") {
      try {
        const parsedLocation = JSON.parse(initialInfo.location);

        coordinates = parsedLocation;

        // Get location information from coordinates
        if (parsedLocation.latitude && parsedLocation.longitude) {
          locationData = await getLocationFromCoordinates(
            parsedLocation.latitude,
            parsedLocation.longitude
          );
        } else if (parsedLocation.coordinates) {
          // Try to find coordinates in a nested structure
          console.log(
            "📍 [LOCATION DEBUG] Checking nested coordinates object:",
            JSON.stringify(parsedLocation.coordinates, null, 2)
          );

          if (
            parsedLocation.coordinates.latitude &&
            parsedLocation.coordinates.longitude
          ) {
            locationData = await getLocationFromCoordinates(
              parsedLocation.coordinates.latitude,
              parsedLocation.coordinates.longitude
            );
          }
        }
      } catch (err) {
        console.error(
          "❌ [LOCATION ERROR] Failed to parse location:",
          err.message
        );
      }
    } else if (initialInfo.location) {
      // Handle various possible coordinate formats
      coordinates = initialInfo.location;

      let lat = null;
      let lng = null;

      // Try different possible structures
      if (coordinates.latitude && coordinates.longitude) {
        lat = coordinates.latitude;
        lng = coordinates.longitude;
      } else if (coordinates.lat && coordinates.lng) {
        lat = coordinates.lat;
        lng = coordinates.lng;
      } else if (
        coordinates.coordinates &&
        Array.isArray(coordinates.coordinates)
      ) {
        // GeoJSON format [longitude, latitude]
        lng = coordinates.coordinates[0];
        lat = coordinates.coordinates[1];
      } else if (
        coordinates.coordinates &&
        typeof coordinates.coordinates === "object"
      ) {
        const nestedCoords = coordinates.coordinates;

        if (nestedCoords.latitude && nestedCoords.longitude) {
          lat = nestedCoords.latitude;
          lng = nestedCoords.longitude;
        } else if (nestedCoords.lat && nestedCoords.lng) {
          lat = nestedCoords.lat;
          lng = nestedCoords.lng;
        } else {
          // If we still don't have coordinates, use the test coordinates as a fallback
          lat = 34.00426808268424;
          lng = 71.50405614269818;
        }
      }

      if (lat && lng) {
        console.log(`📍 [LOCATION] Found coordinates: ${lat}, ${lng}`);
        locationData = await getLocationFromCoordinates(lat, lng);
        console.log(
          `📍 [LOCATION] Retrieved location data from coordinates: ${JSON.stringify(
            locationData
          )}`
        );
      } else {
        console.log(
          "❌ [LOCATION WARNING] Could not find latitude and longitude in the location object"
        );
      }
    }

    // Create visitor data object with all required fields
    const visitorData = {
      visitorId: userId,
      userId: userId,
      name: additionalInfo.name || socket.handshake.query.name || "Anonymous",
      email:
        additionalInfo.email ||
        socket.handshake.query.email ||
        `${userId}@anonymous.com`,
      // Required fields directly on the visitor document (for backward compatibility)
      ipAddress: cleanIp,
      country:
        locationData.country ||
        additionalInfo.country ||
        socket.handshake.query.country ||
        "Unknown",
      city:
        locationData.city ||
        additionalInfo.city ||
        socket.handshake.query.city ||
        "Unknown",

      // Location info (new structured format)
      location: {
        ipAddress: cleanIp,
        coordinates: coordinates,
        country:
          locationData.country ||
          additionalInfo.country ||
          socket.handshake.query.country ||
          "Unknown",
        city:
          locationData.city ||
          additionalInfo.city ||
          socket.handshake.query.city ||
          "Unknown",
        region:
          locationData.region ||
          additionalInfo.region ||
          socket.handshake.query.region ||
          "Unknown",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },

      // Technical info
      userAgent: initialInfo.userAgent || "Unknown",
      screenResolution: initialInfo.screenResolution || "Unknown",
      language: initialInfo.language || "Unknown",
      referralSource:
        additionalInfo.referralSource ||
        socket.handshake.query.referralSource ||
        "direct",
      referralUrl: initialInfo.referralUrl || "direct",

      // Box information
      boxQuestions: {
        sizeOfBoxes:
          additionalInfo.sizeOfBoxes ||
          socket.handshake.query.sizeOfBoxes ||
          "Standard",
        materialOfBoxes:
          additionalInfo.materialOfBoxes ||
          socket.handshake.query.materialOfBoxes ||
          "Cardboard",
        numberOfBoxes: parseInt(
          additionalInfo.numberOfBoxes ||
            socket.handshake.query.numberOfBoxes ||
            1
        ),
        boxWeight: parseInt(
          additionalInfo.boxWeight || socket.handshake.query.boxWeight || 1
        ),
        boxContents:
          additionalInfo.boxContents ||
          socket.handshake.query.boxContents ||
          "General items",
        specialHandling:
          additionalInfo.specialHandling ||
          socket.handshake.query.specialHandling ||
          "None",
      },

      // Initial visit tracking
      firstVisit: new Date(),
      lastVisit: new Date(),
      totalVisits: 1,
    };
    console.log("visitor data", visitorData);

    // Check if visitor already exists
    const existingVisitor = await Visitor.findOne({ visitorId: userId });

    if (existingVisitor) {
      console.log(
        `👤 [VISITOR INFO] Visitor ${userId} already exists, updating visit info only`
      );
      return updateVisitInfo(socket);
    }

    // Create new visitor
    const newVisitor = new Visitor(visitorData);
    await newVisitor.save();

    console.log(
      `👤 [VISITOR SUCCESS] Created new visitor record for ${userId}`
    );

    // Emit to all CSR dashboards in real time
    io.to("csr_room").emit("new_visitor_browsing", {
      userId: newVisitor.userId,
      timestamp: newVisitor.lastVisit || new Date().toISOString(),
      socketId: socket.id,
      visitorData: newVisitor,
    });

    return newVisitor;
  } catch (err) {
    console.error("❌ [VISITOR ERROR] Failed to create visitor:", err);
    console.error(
      "❌ [VISITOR ERROR] Error details:",
      JSON.stringify(err.message)
    );
    return null;
  }
};

// Function to update only visit tracking information (not profile details)
const updateVisitInfo = async (io, socket, additionalInfo = {}) => {
  try {
    const userId = socket.handshake.query.userId;
    if (!userId) {
      console.log(
        "⚠️ [VISITOR WARNING] No userId provided, skipping visit update"
      );
      return null;
    }
    // Only update visit tracking information, not any profile details
    const visitor = await Visitor.findOneAndUpdate(
      { visitorId: userId },
      {
        $inc: { totalVisits: 1 },
        $set: { lastVisit: new Date() },
      },
      { new: true }
    );
    if (!visitor) {
      console.log(
        `⚠️ [VISITOR WARNING] No visitor found with ID ${userId}, creating new record`
      );
      return createVisitor(io, socket, additionalInfo);
    }
    return visitor;
  } catch (err) {
    console.error("❌ [VISITOR ERROR] Failed to update visit info:", err);
    console.error(
      "❌ [VISITOR ERROR] Error details:",
      JSON.stringify(err.message)
    );
    return null;
  }
};

// Main visitor info handling function - decides whether to create or just update visit info
const storeVisitorInfo = async (io, socket, additionalInfo = {}) => {
  try {
    const userId = socket.handshake.query.userId;

    if (!userId) {
      console.log(
        "⚠️ [VISITOR WARNING] No userId provided, skipping visitor storage"
      );
      return null;
    }

    // Check if visitor already exists
    const existingVisitor = await Visitor.findOne({ visitorId: userId });

    if (existingVisitor) {
      // If visitor exists, only update visit info
      return updateVisitInfo(io, socket, additionalInfo);
    } else {
      // If visitor doesn't exist, create a new record with all info
      console.log(
        `👤 [VISITOR NEW] No visitor found for ${userId}, creating new record`
      );
      return createVisitor(io, socket, additionalInfo);
    }
  } catch (err) {
    console.error(
      "❌ [VISITOR ERROR] Failed to process visitor information:",
      err
    );
    console.error(
      "❌ [VISITOR ERROR] Error details:",
      JSON.stringify(err.message)
    );
    return null;
  }
};

const setupSocket = (io) => {
  // Configure Socket.IO for better connection stability
  io.engine.pingTimeout = 600000; // 10 minutes
  io.engine.pingInterval = 25000; // 25 seconds

  // Set up heartbeat mechanism for CSR dashboard
  const heartbeatInterval = 20000; // 20 seconds

  // Set up periodic check to ensure conversations stay active
  const conversationActiveInterval = 60000; // 1 minute

  // Periodically check and ensure conversations stay active for connected users
  setInterval(async () => {
    try {
      // Get all user IDs with active sockets
      const activeUserIds = Array.from(userSockets.keys()).filter(
        (userId) =>
          userSockets.get(userId) && userSockets.get(userId).length > 0
      );

      if (activeUserIds.length > 0) {
        // Ensure all these users have active conversations
        const result = await Conversation.updateMany(
          { userId: { $in: activeUserIds }, isActive: false },
          { $set: { isActive: true, lastActive: new Date() } }
        );

        if (result.modifiedCount > 0) {
          console.log(
            `🔄 [ACTIVE CHECK] Reactivated ${result.modifiedCount} conversations for users with active connections`
          );
        }
      }
    } catch (err) {
      console.error(
        "❌ [ACTIVE CHECK ERROR] Error during active conversation check:",
        err
      );
    }
  }, conversationActiveInterval);

  io.on("connection", async (socket) => {
    console.log(`✅ [CONNECTION] New connection: ${socket.id}`);
    // First check if country is banned
    try {
      const initialInfo = socket.handshake.query.initialInfo
        ? JSON.parse(socket.handshake.query.initialInfo)
        : {};

      const countryCode = initialInfo.country || "Unknown";
      const countryName = initialInfo.countryName || "Unknown";

      // Check if country is banned
      const banConfig = await BanRegion.findOne({ isActive: true });
      if (banConfig) {
        const isBanned = banConfig.bannedCountries.some(
          (banned) => banned.code === countryCode || banned.name === countryName
        );

        if (isBanned) {
          console.log(
            `🚫 [BAN] Blocking connection from ${countryCode} (${countryName})`
          );
          socket.emit("country_banned", {
            message:
              banConfig.banMessage ||
              "Chat service is not available in your region",
          });
          socket.disconnect(true);
          return;
        }
      }
    } catch (err) {
      console.error("❌ [BAN CHECK ERROR]", err);
      // Continue with connection if check fails
    }

    const userId =
      socket.handshake.query.userId || `temp_${socket.id.substring(0, 8)}`;
    socket.userId = userId;

    // FIX 3: Track this socket for the user if it's not a temporary user (race-condition safe)
    if (!userId.startsWith("temp_")) {
      await addUserSocket(userId, socket.id);
    }

    // Add error handling for socket errors
    socket.on("error", (error) => {
      console.error(`❌ [SOCKET ERROR] Error on socket ${socket.id}:`, error);
    });

    // Only emit browsing info if we have a real userId (not a temp one)
    if (socket.handshake.query.userId) {
      // FIX 1: Check if user has started chatting before adding to browsing visitors
      const hasStartedChatting = await Conversation.findOne({ 
        userId, 
        "messages.0": { $exists: true } // Check if conversation has any messages
      });

      if (!hasStartedChatting) {
        // Prepare visitor info for UI (do not save to DB)
        const initialInfo = socket.handshake.query.initialInfo
          ? JSON.parse(socket.handshake.query.initialInfo)
          : {};
        // Use similar logic as createVisitor to build visitorData (but do not save)
        let locationData = {
          country: "Unknown",
          city: "Unknown",
          region: "Unknown",
        };
        let coordinates = null;
        if (initialInfo.location && typeof initialInfo.location === "string") {
          try {
            const parsedLocation = JSON.parse(initialInfo.location);
            coordinates = parsedLocation;
            if (parsedLocation.latitude && parsedLocation.longitude) {
              locationData = await getLocationFromCoordinates(
                parsedLocation.latitude,
                parsedLocation.longitude
              );
            } else if (
              parsedLocation.coordinates &&
              parsedLocation.coordinates.latitude &&
              parsedLocation.coordinates.longitude
            ) {
              locationData = await getLocationFromCoordinates(
                parsedLocation.coordinates.latitude,
                parsedLocation.coordinates.longitude
              );
            }
          } catch {}
        } else if (initialInfo.location) {
          coordinates = initialInfo.location;
          let lat = null,
            lng = null;
          if (coordinates.latitude && coordinates.longitude) {
            lat = coordinates.latitude;
            lng = coordinates.longitude;
          } else if (coordinates.lat && coordinates.lng) {
            lat = coordinates.lat;
            lng = coordinates.lng;
          } else if (
            coordinates.coordinates &&
            Array.isArray(coordinates.coordinates)
          ) {
            lng = coordinates.coordinates[0];
            lat = coordinates.coordinates[1];
          } else if (
            coordinates.coordinates &&
            typeof coordinates.coordinates === "object"
          ) {
            const nestedCoords = coordinates.coordinates;
            if (nestedCoords.latitude && nestedCoords.longitude) {
              lat = nestedCoords.latitude;
              lng = nestedCoords.longitude;
            } else if (nestedCoords.lat && nestedCoords.lng) {
              lat = nestedCoords.lat;
              lng = nestedCoords.lng;
            }
          }
          if (lat && lng) {
            locationData = await getLocationFromCoordinates(lat, lng);
          }
        }
        const ipAddress =
          socket.handshake.headers["x-forwarded-for"] ||
          socket.handshake.address ||
          socket.conn.remoteAddress ||
          "0.0.0.0";
        const cleanIp = ipAddress.replace(/^::ffff:/, "");
        const visitorData = {
          visitorId: userId,
          userId: userId,
          name: socket.handshake.query.name || "Anonymous",
          email: socket.handshake.query.email || `${userId}@anonymous.com`,
          ipAddress: cleanIp,
          country:
            locationData.country || socket.handshake.query.country || "Unknown",
          city: locationData.city || socket.handshake.query.city || "Unknown",
          location: {
            ipAddress: cleanIp,
            coordinates: coordinates,
            country:
              locationData.country || socket.handshake.query.country || "Unknown",
            city: locationData.city || socket.handshake.query.city || "Unknown",
            region:
              locationData.region || socket.handshake.query.region || "Unknown",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          userAgent: initialInfo.userAgent || "Unknown",
          screenResolution: initialInfo.screenResolution || "Unknown",
          language: initialInfo.language || "Unknown",
          referralSource: socket.handshake.query.referralSource || "direct",
          referralUrl: initialInfo.referralUrl || "direct",
          boxQuestions: {},
          firstVisit: new Date(),
          lastVisit: new Date(),
          totalVisits: 1,
          socketId: socket.id,
          timestamp: new Date().toISOString(),
        };

        // FIX 1: Add to browsing visitors map
        browsingVisitors.set(userId, visitorData);
        
        io.to("csr_room").emit("new_visitor_browsing", {
          userId: visitorData.userId,
          timestamp: visitorData.lastVisit,
          socketId: socket.id,
          visitorData,
        });
      }
    }

    // Track typing status
    let typingStatus = "";

    // Track inactivity timeout
    let inactivityTimeout;
    let warningTimeout;
    const INACTIVITY_TIMEOUT = 4 * 60 * 1000;
    const WARNING_TIMEOUT = 60000;

    const resetInactivityTimer = () => {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      if (warningTimeout) clearTimeout(warningTimeout);

      inactivityTimeout = setTimeout(() => {
        console.log(
          `⏳ [INACTIVITY] Warning user ${userId} (${socket.id}) about inactivity`
        );
        socket.emit("receive_message", {
          text: "Are you still there? Please respond or we'll end this chat in 60 seconds.",
          sender: "bot",
          timestamp: new Date().toISOString(),
        });

        warningTimeout = setTimeout(() => {
          if (socket.connected) {
            console.log(
              `⌛ [INACTIVITY] Disconnecting inactive user ${userId} (${socket.id})`
            );
            socket.emit("receive_message", {
              text: "We're ending this chat due to inactivity. Feel free to start a new one anytime!",
              sender: "bot",
              timestamp: new Date().toISOString(),
            });

            setTimeout(() => {
              socket.disconnect(true);
            }, 10000);
          }
        }, WARNING_TIMEOUT);
      }, INACTIVITY_TIMEOUT);
    };

    if (!socket.isCSR) {
      resetInactivityTimer();
    }

    // Load previous conversations on connection
    try {
      const conversation = await Conversation.findOne({ userId })
        .sort({ lastActive: -1 })
        .limit(1);

      if (conversation) {
        console.log(
          `📜 [HISTORY FOUND] Loaded ${conversation.messages.length} previous messages for ${userId}`
        );

        // Always ensure the conversation is active when a user connects
        await Conversation.findByIdAndUpdate(conversation._id, {
          $set: {
            sessionId: socket.id,
            lastActive: new Date(),
            isActive: true, // Always ensure the conversation is active
            // Preserve existing assignment state
            isOpen: conversation.isOpen,
            status: conversation.status,
            alreadyAssigned: conversation.alreadyAssigned,
          },
        });
        // Update the session ID in the userSockets map
        // Restore any pending approvals from the conversation
        if (!userId.startsWith("temp_")) {
          if (!userId.startsWith("temp_")) {
            // Find any pending messages that need approval
            const pendingMessages = conversation.messages.filter(
              (msg) =>
                (msg.status === "pending_approval" ||
                  msg.status === "pending") &&
                msg.approvalId
            );

            // Add them back to the pendingApprovals map
            for (const msg of pendingMessages) {
              console.log(
                `🔄 [RESTORE APPROVAL] Restoring approval request ${msg.approvalId}`
              );

              // Create a copy of the message with proper object conversion
              const msgObject =
                typeof msg.toObject === "function"
                  ? msg.toObject()
                  : { ...msg };

              pendingApprovals.set(msg.approvalId, {
                ...msgObject,
                userId: userId,
                socketId: socket.id, // Update with new socket ID
              });

              // Notify CSRs about the restored approval request
              io.to("csr_room").emit("approval_request", {
                ...msgObject,
                userId: userId,
                socketId: socket.id,
              });
            }

            // Emit user reconnection event to notify CSRs about the new socket ID
            io.to("csr_room").emit("user_reconnected", {
              userId,
              oldSocketId: conversation.sessionId,
              newSocketId: socket.id,
              isOpen: conversation.isOpen,
              status: conversation.status,
              alreadyAssigned: conversation.alreadyAssigned,
              pendingApprovals: pendingMessages.length,
            });
          }
        }

        // Include all messages in chat history, but filter out pending ones for the user
        const processedMessages = conversation.messages.filter((msg) => {
          // Do not include bot messages that are pending approval
          if (msg.status === "pending_approval" && msg.sender === "bot") {
            return false;
          }

          // Keep all other messages
          return true;
        });

        socket.emit("chat_history", processedMessages);
      } else {
        console.log(
          `📭 [NO HISTORY] No previous conversations found for ${userId}`
        );
      }
    } catch (err) {
      console.error(
        "❌ [HISTORY ERROR] Error loading previous conversations:",
        err
      );
    }
    socket.on(
      "new_visitor_browsing",
      ({ userId, timestamp, socketId, visitorData }) => {
        console.log("[SOCKET] Received new_visitor_browsing:", {
          userId,
          timestamp,
          socketId,
          visitorData,
        });
        setBrowsingVisitors((prev) => {
          // Avoid duplicates
          if (prev.some((v) => v.userId === userId)) {
            console.log("[BROWSING] Visitor already in list:", userId);
            return prev;
          }
          console.log("[BROWSING] Adding new browsing visitor:", userId);
          return [
            ...prev,
            {
              ...visitorData,
              socketId,
              timestamp,
              status: "Browsing",
              country: visitorData.location.country || "Unknown",
              city: visitorData.location.city || "Unknown",
            },
          ];
        });
      }
    );

    //    // Handle CSR registration
    socket.on("register_csr", async () => {
      try {
        // When a CSR registers, clear any inactivity timer that might have been set on initial connection.
        // This prevents CSRs from being disconnected due to inactivity.
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        if (warningTimeout) clearTimeout(warningTimeout);

        socket.join("csr_room");
        console.log(`👔 [CSR CONNECT] CSR dashboard joined: ${socket.id}`);
        socket.isCSR = true; // <--- Add this line

        // Get the CSR document ID if available
        let csrId = null;
        if (socket.handshake.query.csrId) {
          csrId = socket.handshake.query.csrId;
          console.log(`👔 [CSR IDENTIFIED] CSR identified with ID: ${csrId}`);

          // Store CSR socket for reconnection tracking
          csrSockets.set(csrId, socket.id);
          socket.csrId = csrId; // Store csrId on socket for disconnect handling
        }
        
        // FIX 1: Send all currently browsing visitors to this CSR dashboard
        emitBrowsingVisitorsToCSR(io, socket);

        // --- SEND ALL CURRENTLY BROWSING VISITORS TO THIS CSR DASHBOARD ---
        const activeBrowsingVisitors = [];
        for (const [userId, socketIds] of userSockets.entries()) {
          // FIX 1: Check if user is in browsing visitors map instead of checking assignments
          if (browsingVisitors.has(userId)) {
            const visitor = browsingVisitors.get(userId);
            activeBrowsingVisitors.push(visitor);
          }
        }
        socket.emit("browsing_visitors_list", activeBrowsingVisitors);
        // Emit a new_visitor_browsing event for each active browsing visitor
        activeBrowsingVisitors.forEach((visitor) => {
          socket.emit("new_visitor_browsing", {
            userId: visitor.userId,
            timestamp: visitor.lastVisit || new Date().toISOString(),
            socketId: visitor.sessionId || "",
            visitorData: visitor,
          });
        });
        // Start heartbeat interval for CSR
        let heartbeatMissed = 0;
        const csrHeartbeat = setInterval(() => {
          if (socket.connected) {
            socket.emit("heartbeat");
            heartbeatMissed = 0;
          } else {
            heartbeatMissed++;
            if (heartbeatMissed > 3) {
              clearInterval(csrHeartbeat);
            }
          }
        }, heartbeatInterval);

        // Handle heartbeat response
        socket.on("heartbeat_response", () => {
          heartbeatMissed = 0;
        });

        // Store heartbeat interval for cleanup on disconnect
        socket.csrHeartbeat = csrHeartbeat;

        // Find any pending approval messages in the database that might not be in memory
        const pendingApprovalConversations = await Conversation.find({
          isActive: true,
          "messages.status": "pending_approval",
        }).lean();

        // Collect all pending approvals from the database
        const dbPendingApprovals = [];

        pendingApprovalConversations.forEach((conv) => {
          const pendingMessages = conv.messages.filter(
            (msg) => msg.status === "pending_approval" && msg.approvalId
          );

          pendingMessages.forEach((msg) => {
            // Only add if not already in the pendingApprovals map
            if (!pendingApprovals.has(msg.approvalId)) {
              console.log(
                `🔄 [RESTORE APPROVAL] Adding missing approval ${msg.approvalId} to map`
              );

              // Add to the map
              pendingApprovals.set(msg.approvalId, {
                ...msg,
                userId: conv.userId,
                socketId: conv.sessionId,
              });

              // Add to the list for initial data
              dbPendingApprovals.push({
                ...msg,
                userId: conv.userId,
                socketId: conv.sessionId,
              });
            }
          });
        });

        const csrInitialData = {
          // Combine in-memory pending approvals with those from the database
          pendingApprovals: [
            ...Array.from(pendingApprovals.values()),
            ...dbPendingApprovals,
          ],
          activeConversations: [],
          openConversations: [],
          recentHistories: [],
        };

        // Get active conversations - only retrieve conversations assigned to CSRs
        // This avoids the ObjectId casting issue by not querying by socket.id
        const activeConversations = await Conversation.find({
          isActive: true,
          isOpen: false,
          status: "assigned",
        })
          .sort({ lastActive: -1 })
          .lean();

        // Filter conversations to show only those assigned to this CSR if csrId is available
        csrInitialData.activeConversations = activeConversations
          .filter((conv) => {
            // If no CSR ID is available, show all assigned conversations
            if (!csrId) return true;
            // Otherwise, check if this conversation is assigned to this CSR
            return (
              conv.assignedTo &&
              conv.assignedTo.some((id) => id.toString() === csrId)
            );
          })
          .map((conv) => ({
            userId: conv.userId,
            sessionId: conv.sessionId,
            lastActive: conv.lastActive,
            messageCount: conv.messages.length,
            lastMessage: conv.messages.slice(-1)[0]?.text || "No messages",
          }));

        // Get open conversations (not assigned to any CSR)
        const openConversations = await Conversation.find({
          isActive: true,
          isOpen: true,
          status: "open",
          $or: [
            { alreadyAssigned: false },
            { alreadyAssigned: { $exists: false } },
          ],
        })
          .sort({ lastActive: -1 })
          .lean();

        // csrInitialData.openConversations = openConversations.map((conv) => ({
        //   userId: conv.userId,
        //   sessionId: conv.sessionId,
        //   lastActive: conv.lastActive,
        //   messageCount: conv.messages.length,
        //   lastMessage: conv.messages.slice(-1)[0]?.text || "No messages",
        // }));
        csrInitialData.openConversations = openConversations
          .filter(
            (conv) =>
              Array.isArray(conv.messages) &&
              conv.messages.some((msg) => msg.sender === "user")
          )
          .map((conv) => ({
            userId: conv.userId,
            sessionId: conv.sessionId,
            lastActive: conv.lastActive,
            messageCount: conv.messages.length,
            lastMessage: conv.messages.slice(-1)[0]?.text || "No messages",
          }));
        // Get recent histories
        const recentHistories = await Conversation.find({ isActive: false })
          .sort({ lastActive: -1 })
          .limit(5)
          .lean();

        csrInitialData.recentHistories = recentHistories.map((conv) => ({
          userId: conv.userId,
          sessionId: conv.sessionId,
          endedAt: conv.lastActive,
          messageCount: conv.messages.length,
          lastMessage: conv.messages.slice(-1)[0]?.text || "No messages",
        }));

        socket.emit("csr_initial_data", csrInitialData);
      } catch (err) {
        console.error("❌ [CSR ERROR] Error initializing CSR dashboard:", err);
        socket.emit("csr_init_error", {
          message: "Failed to load dashboard data",
          error: err.message,
        });
      }
    });

    // Get user ID from socket ID
    socket.on("get_user_id_from_socket", ({ socketId }, callback) => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        callback({
          success: true,
          userId: socket.userId,
          socketId: socket.id,
        });
      } else {
        callback({
          success: false,
          message: "Socket not found",
        });
      }
    });

    // Get user chat history
    socket.on(
      "get_user_chat_history",
      async ({ userId, offset = 0, limit = 30 }, callback) => {
        try {
          if (!userId || typeof userId !== "string") {
            return callback({
              success: false,
              message: "Invalid user identifier",
            });
          }

          const conversation = await Conversation.findOne({ userId })
            .sort({ lastActive: -1 })
            .limit(1);

          if (!conversation) {
            return callback({
              success: false,
              message: "No history found",
            });
          }
          //////////////////////
          // Process messages to keep only the latest pending_approval message
          // const processedMessages = conversation.messages.filter((msg) => {
          //   // Special handling for pending_approval messages
          //   if (msg.status === "pending_approval" && msg.sender === "bot") {
          //     // Find the latest pending_approval message
          //     const latestPendingMsg = conversation.messages
          //       .filter(
          //         (m) => m.status === "pending_approval" && m.sender === "bot"
          //       )
          //       .sort(
          //         (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
          //       )[0];

          //     // Only keep this message if it's the latest pending_approval message
          //     return msg.approvalId === latestPendingMsg?.approvalId;
          //   }

          // Keep all other messages
          //   return true;
          // });
          ////////////////////////////////
          const processedMessages = conversation.messages;

          // Sort messages by timestamp
          const filteredMessages = processedMessages.sort(
            (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
          );

          // Calculate total messages and how many we can load
          const totalMessages = filteredMessages.length;
          const remainingMessages = Math.max(0, totalMessages - offset);
          const messagesToLoad = Math.min(limit, remainingMessages);

          // Get messages from the calculated offset (working backwards)
          const startIndex = Math.max(0, totalMessages - offset - limit);
          const endIndex = totalMessages - offset;
          const slicedMessages = filteredMessages.slice(startIndex, endIndex);

          // Get CSR assignments and visitor information
          let assignedCSRsInfo = [];
          let visitorName = "";

          if (conversation.assignedTo && conversation.assignedTo.length > 0) {
            // Fetch CSR details
            const assignedCSRs = await CSR.find({
              _id: { $in: conversation.assignedTo },
            });

            assignedCSRsInfo = assignedCSRs.map((csr) => ({
              csrId: csr._id,
              name: csr.name || csr.email,
              avatar: csr.avatar || "",
            }));
          } else {
            console.log(
              `ℹ️ [CHAT HISTORY] Conversation history for ${userId} has no CSRs assigned`
            );
          }

          // Fetch visitor name
          const visitor = await Visitor.findOne({ userId });
          if (visitor) {
            visitorName = visitor.name;

            if (visitor.assignedCSRs && visitor.assignedCSRs.length > 0) {
              console.log(
                `👥 [CHAT HISTORY] Visitor has ${visitor.assignedCSRs.length} CSRs in their record:`
              );
            } else {
              console.log(
                `👤 [CHAT HISTORY] Visitor has no CSRs in their record`
              );
            }
          } else {
            console.log(
              `❌ [CHAT HISTORY] No visitor record found for userId: ${userId}`
            );
          }

          const response = {
            success: true,
            userId,
            conversation: {
              sessionId: conversation.sessionId,
              isActive: conversation.isActive,
              lastActive: conversation.lastActive.toISOString(),
              messages: slicedMessages,
              activities: conversation.activities || [], // Include activities in the response
              hasMore: offset + limit < totalMessages,
              totalMessages,
              isOpen: conversation.isOpen,
              status: conversation.status,
              alreadyAssigned: conversation.alreadyAssigned,
              assignedCSRs: assignedCSRsInfo,
              visitorName: visitorName,
              isAssigned: assignedCSRsInfo.length > 0,
            },
          };

          callback(response);

          io.to("csr_room").emit("csr_history_update", {
            userId,
            socketId: socket.id,
            lastUpdated: new Date().toISOString(),
            assignedCSRs: assignedCSRsInfo,
            visitorName: visitorName,
            isAssigned: assignedCSRsInfo.length > 0,
          });
        } catch (err) {
          callback({
            success: false,
            message: "Database error",
            error: err.message,
          });
        }
      }
    );

    // Update the send_message handler to properly emit file messages to CSR room
    socket.on(
      "send_message",
      async ({
        text,
        userId,
        image,
        pdf,
        fileName,
        fileType,
        fileSize,
        visitorInfo,
      }) => {
        if (!socket.isCSR) {
          resetInactivityTimer();
        }

        // FIX 1: Remove user from browsing visitors when they start chatting
        if (userId && browsingVisitors.has(userId)) {
          browsingVisitors.delete(userId);
          io.to("csr_room").emit("visitor_disconnected", { userId });
          console.log(`🗑️ [BROWSING] Removed ${userId} from browsing visitors (started chatting)`);
        }

        // Always update visitor info with each message if we have a userId
        if (userId && !userId.startsWith("temp_")) {
          // Set the userId in the socket handshake query to ensure it's available for visitor functions
          if (!socket.handshake.query.userId) {
            socket.handshake.query.userId = userId;
            socket.userId = userId;
          }

          // Only update visit information for existing visitors (not profile details)
          await updateVisitInfo(io, socket);

          // If explicitly provided with new visitor info (like box details), store it separately
          if (visitorInfo && Object.keys(visitorInfo).length > 0) {
            await Visitor.updateOne(
              { visitorId: userId },
              {
                $set: {
                  ...(visitorInfo.boxQuestions && {
                    "boxQuestions.sizeOfBoxes":
                      visitorInfo.boxQuestions.sizeOfBoxes || undefined,
                    "boxQuestions.materialOfBoxes":
                      visitorInfo.boxQuestions.materialOfBoxes || undefined,
                    "boxQuestions.numberOfBoxes":
                      visitorInfo.boxQuestions.numberOfBoxes || undefined,
                    "boxQuestions.boxWeight":
                      visitorInfo.boxQuestions.boxWeight || undefined,
                    "boxQuestions.boxContents":
                      visitorInfo.boxQuestions.boxContents || undefined,
                    "boxQuestions.specialHandling":
                      visitorInfo.boxQuestions.specialHandling || undefined,
                  }),
                },
              }
            );
          }
        }

        // Create message object based on content type
        const userMessage = {
          sender: "user",
          timestamp: new Date().toISOString(),
          status: "delivered",
          socketId: socket.id,
          userId: userId,
        };

        if (text) {
          userMessage.text = text;
        } else if (image) {
          userMessage.image = image;
          userMessage.fileName = fileName;
          userMessage.fileType = fileType;
          userMessage.fileSize = fileSize;
        } else if (pdf) {
          userMessage.pdf = pdf;
          userMessage.fileName = fileName;
          userMessage.fileType = fileType;
          userMessage.fileSize = fileSize;
        }

        // Find existing conversation to check its state
        const existingConversation = await Conversation.findOne({
          userId,
          isActive: true,
        });

        // Prepare update object with conditional logic for open state
        const updateObject = {
          $push: { messages: userMessage },
          $set: {
            lastActive: new Date(),
            isActive: true,
            sessionId: socket.id,
          },
        };

        // Only reset open state if conversation doesn't exist or isn't already assigned
        if (!existingConversation || !existingConversation.alreadyAssigned) {
          updateObject.$set.isOpen = true;
          updateObject.$set.status = "open";
          updateObject.$set.alreadyAssigned = false;
        }

        const conversation = await Conversation.findOneAndUpdate(
          { userId },
          updateObject,
          { upsert: true, new: true }
        );

        // Check if the conversation is assigned to any CSRs
        let assignedCSRsInfo = [];
        let visitorName = "";
        let totalVisits = 0;

        if (conversation.assignedTo && conversation.assignedTo.length > 0) {
          // Fetch CSR details
          const assignedCSRs = await CSR.find({
            _id: { $in: conversation.assignedTo },
          });

          assignedCSRsInfo = assignedCSRs.map((csr) => ({
            csrId: csr._id,
            name: csr.name || csr.email,
            avatar: csr.avatar || "",
          }));
        } else {
          console.log(
            `ℹ️ [CSR ASSIGNMENT] Message from ${userId} has no CSRs assigned`
          );
        }

        // Fetch visitor name
        const visitor = await Visitor.findOne({ userId });
        if (visitor) {
          visitorName = visitor.name;

          if (visitor.assignedCSRs && visitor.assignedCSRs.length > 0) {
            console.log(
              `👥 [VISITOR CSRs] Visitor has ${visitor.assignedCSRs.length} CSRs in their record:`
            );
          } else {
            console.log(
              `👤 [VISITOR CSRs] Visitor has no CSRs in their record`
            );
          }
        } else {
          console.log(
            `❌ [VISITOR INFO] No visitor record found for userId: ${userId}`
          );
        }

        socket.emit("message_sent", {
          ...userMessage,
          dbId: conversation._id,
          assignedCSRs: assignedCSRsInfo,
          visitorName: visitorName,
        });

        // Emit to CSR room with all file data and CSR assignment info
        io.to("csr_room").emit("receive_user_message", {
          ...userMessage,
          userId: userId,
          socketId: socket.id,
          assignedCSRs: assignedCSRsInfo,
          visitorName: visitorName,
          isAssigned: assignedCSRsInfo.length > 0,
        });

        // Only generate bot reply for text messages
        if (text) {
          try {
            socket.emit("typing_status", true);
            // Prepare previousMessages array for chatbot
            const previousMessages =
              conversation && conversation.messages
                ? conversation.messages
                    .map((msg) => {
                      let role;
                      if (msg.sender === "user") role = "human";
                      else if (msg.sender === "bot") role = "ai";
                      else if (msg.sender === "csr")
                        role = "ai"; // treat CSR as AI for chat context
                      else if (msg.sender === "system") role = "system";
                      else role = "system"; // fallback

                      const content = msg.text || msg.image || msg.pdf || "";
                      if (!content) return null; // filter out empty messages

                      return { role, content };
                    })
                    .filter(Boolean)
                : [];
            // // // Log the new query and previous messages for debugging
            // console.log("[CHATBOT DEBUG] New user query:", text);
            // console.log("[CHATBOT DEBUG] Previous messages:", previousMessages);
            const botResult = await chatbot(text, previousMessages);
            // Extract plain text from AIMessage or fallback
            const botText =
              botResult?.content ||
              (typeof botResult === "string"
                ? botResult
                : JSON.stringify(botResult));
            // Compose botReply object to match previous structure
            const botReply = {
              text: botText,
              sender: "bot",
              timestamp: new Date().toISOString(),
              status: "pending_approval",
              originalText: botText,
              socketId: socket.id,
              approvalId: `approval_${Date.now()}_${Math.random()
                .toString(36)
                .substr(2, 5)}`,
              userId: userId,
            };

            // Ensure the status is explicitly set to pending_approval
            botReply.status = "pending_approval";

            // Store in memory for immediate access
            pendingApprovals.set(botReply.approvalId, {
              ...botReply,
              userId: userId,
              assignedCSRs: assignedCSRsInfo,
              visitorName: visitorName,
            });

            // Store in database with explicit status
            await Conversation.findOneAndUpdate(
              { userId, isActive: true },
              {
                $push: { messages: botReply },
                $set: { lastActive: new Date() },
              }
            );

            // Get the updated conversation to find the latest pending message
            const updatedConversation = await Conversation.findOne({
              userId,
              isActive: true,
            });

            // Find all pending approval bot messages
            const pendingMessages = updatedConversation.messages.filter(
              (msg) => msg.status === "pending_approval" && msg.sender === "bot"
            );

            // Sort by timestamp, newest first
            const sortedPendingMessages = pendingMessages.sort(
              (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
            );

            // The latest pending message is the first one after sorting
            const latestPendingMsg = sortedPendingMessages[0];

            // Send only the latest pending message to all user sockets
            /* if (latestPendingMsg) {
              const enrichedPendingMsg = {
                ...latestPendingMsg,
                isLatestPending: true,
                assignedCSRs: assignedCSRsInfo,
                visitorName: visitorName,
              };

              // Get all sockets for this user
              if (userSockets.has(userId)) {
                const userSocketIds = userSockets.get(userId);

                userSocketIds.forEach((socketId) => {
                  io.to(socketId).emit("receive_message", enrichedPendingMsg);
                });
              } else {
                // Fallback to just the current socket
                console.log(
                  `🤖 [BOT RESPONSE] Sending pending bot response to current socket ${socket.id} for user ${userId}`
                );
                socket.emit("receive_message", enrichedPendingMsg);
              }
            } */

            // For CSRs only, send as pending approval with assignment info
            io.to("csr_room").emit("approval_request", {
              ...botReply,
              userId: userId,
              assignedCSRs: assignedCSRsInfo,
              visitorName: visitorName,
              isAssigned: assignedCSRsInfo.length > 0,
            });

            setTimeout(() => {
              socket.emit("typing_status", false);
            }, 1500);
          } catch (err) {
            console.error("❌ [BOT ERROR] Error generating bot reply:", err);
            const errorMessage = {
              text: "Sorry, I couldn't process that right now.",
              sender: "bot",
              timestamp: new Date().toISOString(),
              status: "error",
              socketId: socket.id,
            };

            socket.emit("receive_message", errorMessage);
            await Conversation.findOneAndUpdate(
              { userId, isActive: true },
              {
                $push: { messages: errorMessage },
                $set: { lastActive: new Date() },
              }
            );
          }
        }
      }
    );
    //approve reply event handler
    socket.on(
      "approve_reply",
      async ({
        approvalId,
        editedText,
        finalText,
        socketId,
        csrName,
        status,
        userId,
      }) => {
        console.log(
          "🔍 [APPROVE REPLY DEBUG] Received approve_reply event with data:"
        );

        const pendingReply = pendingApprovals.get(approvalId);
        if (!pendingReply) {
          console.error(
            "❌ [APPROVAL ERROR] Approval ID not found:",
            approvalId
          );
          return;
        }
        // Get CSR info - prioritize passed csrName, then socket data, then fallback
        let approverCSRName = csrName;
        let approverCSRId = socket.csrId || socket.id;

        // If no csrName passed, try to get it from socket or database
        if (!approverCSRName) {
          // Try to get from socket first
          approverCSRName = socket.csrName;

          // If still no name, try to fetch from database using csrId
          if (!approverCSRName && socket.csrId) {
            try {
              const csr = await CSR.findById(socket.csrId);
              if (csr) {
                approverCSRName = csr.name || csr.email;
                approverCSRId = csr._id;
              }
            } catch (error) {
              console.error("Error fetching CSR info:", error);
            }
          }

          // Final fallback
          if (!approverCSRName) {
            approverCSRName = "CSR";
          }
        }

        const finalReply = {
          ...pendingReply,
          text: editedText || pendingReply.originalText,
          sender: "bot",
          status: status || "approved",
          approvedAt: new Date().toISOString(),
          approvedBy: approverCSRId,
          approvedByName: approverCSRName, // Store CSR name who approved
          userId: userId,
          timestamp: new Date().toISOString(),
          socketId: pendingReply.socketId,
        };

        // Update the database with CSR approval information
        await Conversation.updateOne(
          { userId: pendingReply.userId, "messages.approvalId": approvalId },
          {
            $set: {
              "messages.$.text": finalReply.text,
              "messages.$.status": status || "approved",
              "messages.$.approvedAt": finalReply.approvedAt,
              "messages.$.approvedBy": finalReply.approvedBy,
              "messages.$.approvedByName": finalReply.approvedByName, // Store CSR name in database
              lastActive: new Date(),
            },
          }
        );

        // Get the updated conversation to check for CSR assignments
        const conversation = await Conversation.findOne({
          userId: pendingReply.userId,
          isActive: true,
        });

        // Get CSR assignments and visitor information
        let assignedCSRsInfo = [];
        let visitorName = "";

        if (
          conversation &&
          conversation.assignedTo &&
          conversation.assignedTo.length > 0
        ) {
          // Fetch CSR details
          const assignedCSRs = await CSR.find({
            _id: { $in: conversation.assignedTo },
          });

          assignedCSRsInfo = assignedCSRs.map((csr) => ({
            csrId: csr._id,
            name: csr.name || csr.email,
            avatar: csr.avatar || "",
          }));
        } else {
          console.log(
            `ℹ️ [APPROVE REPLY] Reply for ${pendingReply.userId} has no CSRs assigned`
          );
        }

        // Fetch visitor name
        const visitor = await Visitor.findOne({ userId: pendingReply.userId });
        if (visitor) {
          visitorName = visitor.name;

          if (visitor.assignedCSRs && visitor.assignedCSRs.length > 0) {
            console.log(
              `👥 [APPROVE REPLY] Visitor has ${visitor.assignedCSRs.length} CSRs in their record:`
            );
          } else {
            console.log(
              `👤 [APPROVE REPLY] Visitor has no CSRs in their record`
            );
          }
        } else {
          console.log(
            `❌ [APPROVE REPLY] No visitor record found for userId: ${pendingReply.userId}`
          );
        }

        // Add CSR and visitor info to the reply
        finalReply.assignedCSRs = assignedCSRsInfo;
        finalReply.visitorName = visitorName;
        finalReply.isAssigned = assignedCSRsInfo.length > 0;
        finalReply.csrName = approverCSRName; // Include CSR name in the final reply

        // Send to all user sockets instead of just the original socket
        const userSocketIds = userSockets.get(pendingReply.userId) || [];
        if (userSocketIds.length > 0) {
          console.log(
            `📣 [BOT REPLY] Broadcasting approved bot reply to ${userSocketIds.length} sockets for user ${pendingReply.userId} (approved by ${approverCSRName})`
          );

          // Send to all user sockets
          userSocketIds.forEach((socketId) => {
            io.to(socketId).emit("receive_message", finalReply);
          });
        } else {
          // Fallback to original socket if no sockets in tracking map
          console.log(
            `📣 [BOT REPLY] Sending to original socket ${pendingReply.socketId} for user ${pendingReply.userId} (approved by ${approverCSRName})`
          );
          io.to(pendingReply.socketId).emit("receive_message", finalReply);
        }

        // Send to CSR room with CSR name and approval information
        io.to("csr_room").emit("reply_approved", {
          approvalId,
          finalText: finalReply.text,
          socketId: pendingReply.socketId,
          userId: pendingReply.userId,
          csrName: approverCSRName, // Include who approved it
          csrId: approverCSRId, // Include CSR ID
          status: status || "approved",
          alreadyRendered: true,
          assignedCSRs: assignedCSRsInfo,
          visitorName: visitorName,
          isAssigned: assignedCSRsInfo.length > 0,
          approvedAt: finalReply.approvedAt,
        });

        pendingApprovals.delete(approvalId);

        // Get the updated conversation to find if there's a new latest pending message
        const updatedConversation = await Conversation.findOne({
          userId: pendingReply.userId,
          isActive: true,
        });

        /* if (updatedConversation) {
          // Find all pending approval bot messages
          const pendingMessages = updatedConversation.messages.filter(
            (msg) => msg.status === "pending_approval" && msg.sender === "bot"
          );

          // Sort by timestamp, newest first
          const sortedPendingMessages = pendingMessages.sort(
            (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
          );

          // The latest pending message is the first one after sorting
          const latestPendingMsg = sortedPendingMessages[0];

          // Send the latest pending message to all user sockets if there is one
          if (latestPendingMsg) {
            const enrichedPendingMsg = {
              ...latestPendingMsg,
              isLatestPending: true,
              assignedCSRs: assignedCSRsInfo,
              visitorName: visitorName,
              isAssigned: assignedCSRsInfo.length > 0,
            };

            const userSocketIds = userSockets.get(pendingReply.userId) || [];
            if (userSocketIds.length > 0) {
              console.log(
                `📣 [BOT PENDING] Broadcasting latest pending message to ${userSocketIds.length} sockets for user ${pendingReply.userId}`
              );

              // Send to all user sockets
              userSocketIds.forEach((socketId) => {
                io.to(socketId).emit("receive_message", enrichedPendingMsg);
              });
            } else {
              // Fallback to original socket if no sockets in tracking map
              console.log(
                `📣 [BOT PENDING] Sending latest pending message to original socket ${pendingReply.socketId}`
              );
              io.to(pendingReply.socketId).emit(
                "receive_message",
                enrichedPendingMsg
              );
            }
          }
        } */

        console.log(
          `✅ [APPROVAL SUCCESS] Reply approved by ${approverCSRName} (${approverCSRId}) for user ${pendingReply.userId}`
        );
      }
    );
    // Reject reply event handler
    socket.on("reject_reply", async ({ approvalId, reason }) => {
      const pendingReply = pendingApprovals.get(approvalId);
      if (!pendingReply) {
        console.error(
          "❌ [REJECTION ERROR] Approval ID not found:",
          approvalId
        );
        return;
      }

      await Conversation.updateOne(
        { userId: pendingReply.userId, "messages.approvalId": approvalId },
        {
          $set: {
            "messages.$.status": "rejected",
            "messages.$.rejectedAt": new Date().toISOString(),
            "messages.$.rejectedBy": socket.id,
            "messages.$.rejectionReason": reason,
          },
        }
      );

      io.to("csr_room").emit("reply_rejected", {
        approvalId,
        reason,
        socketId: pendingReply.socketId,
      });

      pendingApprovals.delete(approvalId);

      // Get the updated conversation to find if there's a new latest pending message
      const updatedConversation = await Conversation.findOne({
        userId: pendingReply.userId,
        isActive: true,
      });

      /* if (updatedConversation) {
        // Find all pending approval bot messages
        const pendingMessages = updatedConversation.messages.filter(
          (msg) => msg.status === "pending_approval" && msg.sender === "bot"
        );

        // Sort by timestamp, newest first
        const sortedPendingMessages = pendingMessages.sort(
          (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
        );

        // The latest pending message is the first one after sorting
        const latestPendingMsg = sortedPendingMessages[0];

        // Send the latest pending message to all user sockets if there is one
        if (latestPendingMsg) {
          const enrichedPendingMsg = {
            ...latestPendingMsg,
            isLatestPending: true, // Add a flag to identify it as the latest pending message
          };

          const userSocketIds = userSockets.get(pendingReply.userId) || [];
          if (userSocketIds.length > 0) {
            console.log(
              `📣 [REJECT REPLY] Broadcasting latest pending message to ${userSocketIds.length} sockets after rejection for user ${pendingReply.userId}`
            );

            // Send to all user sockets
            userSocketIds.forEach((socketId) => {
              io.to(socketId).emit("receive_message", enrichedPendingMsg);
            });
          } else {
            // Fallback to original socket if no sockets in tracking map
            console.log(
              `📣 [REJECT REPLY] Sending latest pending message to original socket ${pendingReply.socketId} after rejection`
            );
            io.to(pendingReply.socketId).emit(
              "receive_message",
              enrichedPendingMsg
            );
          }
        }
      } */
    });

    // In your socket handler file
    socket.on("csr_takeover", async ({ socketId, csrId }) => {
      try {
        // Get the CSR ID from the query params or from the passed csrId
        let csrIdentifier = null;
        if (socket.handshake.query.csrId) {
          csrIdentifier = socket.handshake.query.csrId;
        } else if (csrId) {
          csrIdentifier = csrId;
        }

        if (!csrIdentifier) {
          console.error(
            "❌ [TAKEOVER ERROR] No CSR ID available for assignment"
          );
          return;
        }

        // First, find the conversation to get userId
        const conversation = await Conversation.findOne({
          sessionId: socketId,
          isActive: true,
        });

        if (!conversation) {
          console.error(
            `❌ [TAKEOVER ERROR] No active conversation found for socket: ${socketId}`
          );
          return;
        }

        // Get CSR information
        const csrInfo = await CSR.findById(csrIdentifier).select("name avatar");

        // Update the conversation to mark it as taken over and add activity
        const joinActivity = {
          type: "csr_join",
          csrId: csrIdentifier,
          csrName: csrInfo?.name || "Customer Support",
          csrAvatar: csrInfo?.avatar || "",
          timestamp: new Date(),
          metadata: {
            joinedAt: new Date(),
            assignmentType: "takeover",
          },
        };

        await Conversation.findByIdAndUpdate(conversation._id, {
          $set: {
            isOpen: false,
            alreadyAssigned: true,
            status: "assigned",
          },
          $addToSet: { assignedTo: csrIdentifier },
          $push: { activities: joinActivity },
        });

        //added for emition
        io.to("csr_room").emit("csr_takeover", {
          userId: conversation.userId,
          csrId: csrIdentifier,
          csrName: csrInfo?.name || "Customer Support",
          csrAvatar: csrInfo?.avatar || "",
        });
        ///till hre
      } catch (err) {
        console.error("❌ [TAKEOVER ERROR] Error taking over chat:", err);
      }
    });

    // Handle typing indicators
    socket.on("typing_status", (text) => {
      typingStatus = text;
      io.to("csr_room").emit("typing_status", {
        socketId: socket.id,
        userId: userId,
        isTyping: !!text,
      });
      if (!socket.isCSR) {
        clearTimeout(socket.typingTimeout);
        socket.typingTimeout = setTimeout(() => {
          typingStatus = "";
          io.to("csr_room").emit("typing_status", {
            socketId: socket.id,
            isTyping: false,
          });
        }, 2000);
      }
    });

    socket.on("csr_direct_message", async ({ userId, message }) => {
      try {
        const csrMessage = {
          text: message,
          sender: "csr",
          timestamp: new Date().toISOString(),
          status: "delivered",
          csrUserId: socket.userId,
        };

        // First, find or create a conversation without marking it as open
        let conversation = await Conversation.findOne({ userId });

        if (!conversation) {
          // Create a new conversation but keep it closed (isOpen: false)
          // Use "open" as the default status instead of "pending"
          conversation = new Conversation({
            userId,
            sessionId: socket.id,
            isActive: true,
            isOpen: false, // Keep conversation closed until visitor responds
            status: "open", // Changed from "pending" to "open"
            alreadyAssigned: false,
            assignedTo: [],
            messages: [csrMessage], // Store the CSR message
            lastActive: new Date(),
          });
          await conversation.save();
        } else {
          // If conversation exists, just add the message without changing open status
          await Conversation.findByIdAndUpdate(conversation._id, {
            $push: { messages: csrMessage },
            $set: { lastActive: new Date(), isActive: true },
          });
        }

        // Get CSR info for notification
        const csr = socket.csrId ? await CSR.findById(socket.csrId) : null;
        const csrName = csr?.name || "Customer Support";

        // Enhanced delivery logic:
        let delivered = false;

        // 1. Try sending through userSockets map first
        if (userSockets.has(userId)) {
          const userSocketIds = userSockets.get(userId);
          console.log(
            `📩 [CSR DM] Sending to ${userSocketIds.length} sockets for user ${userId}`
          );

          userSocketIds.forEach((socketId) => {
            if (io.sockets.sockets.get(socketId)) {
              io.to(socketId).emit("receive_message", {
                ...csrMessage,
                userId,
                csrName, // Include CSR name in the message
              });
              delivered = true;
            } else {
              // Clean up stale socket IDs
              userSockets.set(
                userId,
                userSockets.get(userId).filter((id) => id !== socketId)
              );
            }
          });
        }

        // 2. Fallback to finding socket by userId
        if (!delivered) {
          console.log(
            `🔍 [CSR DM] Falling back to socket search for user ${userId}`
          );
          const sockets = Array.from(io.sockets.sockets.values());
          const userSocket = sockets.find((s) => s.userId === userId);

          if (userSocket) {
            userSocket.emit("receive_message", {
              ...csrMessage,
              userId,
              csrName,
            });
            delivered = true;
            console.log(
              `✅ [CSR DM] Found and delivered to fallback socket for ${userId}`
            );
          }
        }

        if (!delivered) {
          console.log(
            `⚠️ [CSR DM] Could not deliver message to user ${userId} - no active sockets found`
          );
        }

        // Notify CSRs with delivery status
        io.to("csr_room").emit("csr_message_sent", {
          ...csrMessage,
          userId,
          socketId: socket.id,
          isAssigned: false,
          delivered, // Include delivery status
          csrName, // Include CSR name in notification
        });
      } catch (err) {
        console.error("❌ [CSR DM ERROR] Error sending direct message:", err);
        console.error(err.stack);

        // Notify CSRs about the error
        io.to("csr_room").emit("csr_message_error", {
          userId,
          message: "Failed to send message",
          error: err.message,
        });
      }
    });

    socket.on("csr_typing_status", ({ userId, isTyping, text }) => {
      // Broadcast to all user's active sockets
      if (userSockets.has(userId)) {
        const userSocketIds = userSockets.get(userId);

        userSocketIds.forEach((socketId) => {
          io.to(socketId).emit("user_typing_status", {
            userId: socket.userId, // The CSR's user ID
            isTyping,
            text, // Forward the text to the user
          });
        });
      } else {
        // Fallback to traditional approach
        const userSocket = Array.from(io.sockets.sockets.values()).find(
          (s) => s.userId === userId
        );

        if (userSocket) {
          userSocket.emit("user_typing_status", {
            userId: socket.userId, // The CSR's user ID
            isTyping,
            text, // Forward the text to the user
          });
        } else {
          console.log(
            `⚠️ [CSR TYPING] No active sockets found for user ${userId}, typing status not delivered`
          );
        }
      }
    });
    // Handle CSR reconnection request
    socket.on("csr_reconnect", async ({ csrId }) => {
      try {
        if (!csrId) {
          console.log(`⚠️ [CSR RECONNECT] No CSR ID provided for reconnection`);
          return;
        }

        // Update the tracking map with the new socket ID
        csrSockets.set(csrId, socket.id);
        socket.csrId = csrId;

        // Join the CSR room
        socket.join("csr_room");

        // FIX 1: Emit browsing visitors on CSR reconnection
        emitBrowsingVisitorsToCSR(io, socket);

        // Emit success message
        socket.emit("csr_reconnect_success");

        // Call the register_csr handler to refresh the dashboard data
        const registerHandler = socket._events.register_csr;
        if (typeof registerHandler === "function") {
          registerHandler.call(socket);
        }
      } catch (err) {
        console.error(`❌ [CSR RECONNECT ERROR] ${err.message}`);
        socket.emit("csr_reconnect_error", { error: err.message });
      }
    });

    socket.on("user_reconnect", async ({ userId }) => {
      try {
        if (!userId || userId.startsWith("temp_")) return;

        console.log(
          `🔄 [RECONNECT] User ${userId} reconnecting with socket ${socket.id}`
        );

        // FIX 3: Update socket tracking (race-condition safe)
        await addUserSocket(userId, socket.id);

        // Set userId on socket object
        socket.userId = userId;

        // Find and update the conversation
        const conversation = await Conversation.findOneAndUpdate(
          { userId },
          {
            $set: {
              sessionId: socket.id,
              lastActive: new Date(),
              isActive: true, // Ensure it stays active
            },
          },
          { new: true, upsert: true }
        );

        if (conversation) {
          console.log(
            `🔄 [RECONNECT] Updated conversation for user ${userId} with new socket ${socket.id}`
          );

          // Restore pending approvals
          const pendingMessages = conversation.messages.filter(
            (msg) => msg.status === "pending_approval" && msg.approvalId
          );

          for (const msg of pendingMessages) {
            const msgObj =
              typeof msg.toObject === "function" ? msg.toObject() : { ...msg };
            pendingApprovals.set(msg.approvalId, {
              ...msgObj,
              userId,
              socketId: socket.id,
            });
            console.log(
              `🔄 [RECONNECT] Restored pending approval ${msg.approvalId} for user ${userId}`
            );
          }

          // Notify CSRs about the reconnection
          io.to("csr_room").emit("user_reconnected", {
            userId,
            oldSocketId: conversation.sessionId,
            newSocketId: socket.id,
            isOpen: conversation.isOpen,
            status: conversation.status,
            alreadyAssigned: conversation.alreadyAssigned,
            pendingApprovals: pendingMessages.length,
          });
        }
      } catch (err) {
        console.error(
          "❌ [RECONNECT ERROR] Error handling user reconnection:",
          err
        );
        console.error(err.stack);
      }
    });
    socket.on("user_connected", async ({ userId }) => {
      console.log(
        `✅ [CONNECTION] User ${userId} connected with socket ${socket.id}`
      );

      // Make sure userId is set on the socket
      socket.userId = userId;

      // Ensure we have an active conversation for this user
      const conversation = await Conversation.findOneAndUpdate(
        { userId },
        {
          $set: {
            sessionId: socket.id,
            lastActive: new Date(),
            isActive: true, // Explicitly set to active
          },
        },
        { upsert: true, new: true }
      );

      console.log(
        `🔄 [CONVERSATION] Ensured active conversation for user ${userId}`
      );

      // If this is a reconnection, make sure we notify CSRs
      if (conversation) {
        io.to("csr_room").emit("user_reconnected", {
          userId: userId,
          oldSocketId: conversation.sessionId,
          newSocketId: socket.id,
          isOpen: conversation.isOpen,
          status: conversation.status,
          alreadyAssigned: conversation.alreadyAssigned,
        });
      }
    });

    socket.on("disconnect", async () => {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      if (warningTimeout) clearTimeout(warningTimeout);

      // Clean up CSR-specific resources
      if (socket.csrHeartbeat) {
        clearInterval(socket.csrHeartbeat);
      }

      // If this was a CSR socket, remove it from tracking
      if (socket.csrId) {
        csrSockets.delete(socket.csrId);
      }

      // FIX 3: Track user sockets and update conversation status (race-condition safe)
      const userId = socket.userId;
      if (userId && !userId.startsWith("temp_")) {
        const remainingConnections = await removeUserSocket(userId, socket.id);
        
        if (remainingConnections > 0) {
          console.log(
            `🔄 [CONVERSATION] Keeping conversation active - user ${userId} still has ${remainingConnections} active connections`
          );
        } else {
          // No more active sockets for this user
          
          // FIX 1: Remove from browsing visitors when disconnecting
          if (browsingVisitors.has(userId)) {
            browsingVisitors.delete(userId);
            io.to("csr_room").emit("visitor_disconnected", { userId });
            console.log(`🗑️ [BROWSING] Removed ${userId} from browsing visitors (disconnected)`);
          }
          
          console.log(
            `👋 [USER SOCKET TRACKING] User ${userId} has no more active connections`
          );

          // Only mark as inactive if this was the last socket
          const result = await Conversation.updateMany(
            { userId, isActive: true },
            { $set: { isActive: false } }
          );
          if (result.modifiedCount > 0) {
            console.log(
              `📴 [CONVERSATION] Marked conversation as inactive for ${userId}`
            );
          }
        }
      } else {
        // For temporary sockets, directly mark conversation as inactive
        const result = await Conversation.updateMany(
          { sessionId: socket.id, isActive: true },
          { $set: { isActive: false } }
        );
        if (result.modifiedCount > 0) {
          console.log(
            `📴 [CONVERSATION] Marked conversation as inactive for temporary user with socket ${socket.id}`
          );
        }
      }

      // Only clean up pending approvals if this was the last socket for this user
      if (userId && !userId.startsWith("temp_")) {
        // FIX 3: Check if the user has other active sockets (race-condition safe)
        const hasActiveConnections = getUserSocketCount(userId) > 0;

        if (!hasActiveConnections) {
          // This was the last socket, clean up pending approvals
          for (const [approvalId, reply] of pendingApprovals.entries()) {
            if (reply.userId === userId) {
              pendingApprovals.delete(approvalId);
              io.to("csr_room").emit("pending_approval_cancelled", approvalId);
              console.log(
                `🧹 [CLEANUP] Removed pending approval ${approvalId} for disconnected user ${userId}`
              );
            }
          }
        } else {
          console.log(
            `📝 [CLEANUP] Keeping pending approvals for user ${userId} as they have ${getUserSocketCount(userId)} active connections`
          );
        }
      } else {
        // For temporary users, clean up approvals for this specific socket
        for (const [approvalId, reply] of pendingApprovals.entries()) {
          if (reply.socketId === socket.id) {
            pendingApprovals.delete(approvalId);
            io.to("csr_room").emit("pending_approval_cancelled", approvalId);
            console.log(
              `🧹 [CLEANUP] Removed pending approval ${approvalId} for disconnected socket ${socket.id}`
            );
          }
        }
      }
    });
  });

  // Handle CSR reconnection attempts from client
  io.of("/").adapter.on("join-room", (room, id) => {
    if (room === "csr_room") {
      // Send an immediate ping to verify connection
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        socket.emit("connection_check");
      }
    }
  });
};

export default setupSocket;