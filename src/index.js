import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { getUserInformationBasedOnUserId } from "./utils.js";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Route to handle incoming calls from Twilio
fastify.all("/twilio/inbound_call", async (request, reply) => {
  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Route to initiate outbound calls
fastify.post("/outbound-call/:userId", async (request, reply) => {
  const { userId } = request.params;
  const { prompt, first_message } = request.body;

  if (!userId) {
    return reply.code(400).send({ error: "User ID is required" });
  }

  const user = await getUserInformationBasedOnUserId(userId);
  console.log("User information:", user);

  const addQueryParameter = (key, value) => {
    if (value != "undefined") {
      return `&${key}=${encodeURIComponent(value)}`;
    }
    return "";
  };

  let url = `https://${request.headers.host}/outbound-call-twiml?`;
  url += addQueryParameter("prompt", prompt);
  url += addQueryParameter("first_message", first_message);
  url += addQueryParameter("phoneNumber", user.phoneNumber);
  url += addQueryParameter("userName", user.name);
  url += addQueryParameter("userId", userId);
  url += addQueryParameter("friendUserIds", user.friendUserIds);
  console.log("Outbound call URL:", url);

  try {
    console.log("Initiating outbound call");
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: user.phoneNumber,
      url,
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";
  const phoneNumber = request.query.phoneNumber || "";
  const userName = request.query.userName || "";
  const userId = request.query.userId || "";
  const friendUserIds = request.query.friendUserIds || "";
  // one line console.log
  console.log(`prompt: ${prompt}`);
  console.log(`first_message: ${first_message}`);
  console.log(`phoneNumber: ${phoneNumber}`);
  console.log(`userName: ${userName}`);
  console.log(`userId: ${userId}`);

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
            <Parameter name="phoneNumber" value="${phoneNumber}" />
            <Parameter name="userName" value="${userName}" />
            <Parameter name="userId" value="${userId}" />
            <Parameter name="friendUserIds" value="${friendUserIds}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});
// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null; // Add this to store parameters

      // Handle WebSocket errors
      ws.on("error", console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {},
              },
              dynamic_variables: {
                name: customParameters.userName,
                phoneNumber: customParameters.phoneNumber,
                userId: customParameters.userId,
                friendUserIds: customParameters.friendUserIds,
              },
            };

            const addConversationConfigOverride = (key, value) => {
              if (value != "undefined") {
                initialConfig.conversation_config_override.agent[key] = value;
              }
            };

            addConversationConfigOverride("prompt", customParameters.prompt);
            addConversationConfigOverride(
              "first_message",
              customParameters.first_message
            );

            console.log(initialConfig);

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log(
                      "[ElevenLabs] Received audio but no StreamSid yet"
                    );
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(
                      JSON.stringify({
                        event: "clear",
                        streamSid,
                      })
                    );
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id,
                      })
                    );
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_transcript":
                  console.log(
                    `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                  );
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      const loadAdditionalInformation = async () => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            return resolve(null);
          }, 1000);
        });
      };

      // Handle messages from Twilio
      ws.on("message", async (message) => {
        try {
          const msg = JSON.parse(message);
          if (msg.event !== "media") {
            console.log(`[Twilio] Received event: ${msg.event}`);
          }

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters; // Store parameters
              console.log("customParameters", customParameters);

              console.log("Loading additional information");
              await loadAdditionalInformation();
              console.log("Additional information loaded");

              console.log(
                `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
              );
              console.log("[Twilio] Start parameters:", customParameters);

              // After user information is retrieved, now we can setup ElevenLabs
              console.log("Setting up ElevenLabs");
              await setupElevenLabs();
              console.log("ElevenLabs setup complete");
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    msg.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );

  fastifyInstance.get("/media-stream", { websocket: true }, (ws, req) => {
    console.info("[Server] Twilio connected to media stream");

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null; // Add this to store parameters

    // Handle WebSocket errors
    ws.on("error", console.error);

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("[ElevenLabs] Connected to Conversational AI");

          // dynamic_variables: {
          //   name: customParameters.userName,
          //   phoneNumber: customParameters.phoneNumber,
          //   userId: customParameters.userId,
          //   friendUserIds: customParameters.friendUserIds,
          // },
          // Send initial configuration with prompt and first message containing userFriendIds
          const initialConfig = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {},
            },
            dynamic_variables: {
              friendUserIds: "2,3",
              phoneNumber: "+491709004593",
              userId: "1",
            },
          };

          console.log(initialConfig);

          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);

            switch (message.type) {
              case "conversation_initiation_metadata":
                console.log("[ElevenLabs] Received initiation metadata");
                break;

              case "audio":
                if (streamSid) {
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                } else {
                  console.log(
                    "[ElevenLabs] Received audio but no StreamSid yet"
                  );
                }
                break;

              case "interruption":
                if (streamSid) {
                  ws.send(
                    JSON.stringify({
                      event: "clear",
                      streamSid,
                    })
                  );
                }
                break;

              case "ping":
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id,
                    })
                  );
                }
                break;

              case "agent_response":
                console.log(
                  `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                );
                break;

              case "user_transcript":
                console.log(
                  `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                );
                break;

              default:
                console.log(
                  `[ElevenLabs] Unhandled message type: ${message.type}`
                );
            }
          } catch (error) {
            console.error("[ElevenLabs] Error processing message:", error);
          }
        });

        elevenLabsWs.on("error", (error) => {
          console.error("[ElevenLabs] WebSocket error:", error);
        });

        elevenLabsWs.on("close", () => {
          console.log("[ElevenLabs] Disconnected");
        });
      } catch (error) {
        console.error("[ElevenLabs] Setup error:", error);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on("message", (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== "media") {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            console.log(
              `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
            );
            break;

          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(
                  msg.media.payload,
                  "base64"
                ).toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case "stop":
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    // Handle WebSocket closure
    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
