const express = require("express");
const multer = require("multer");
const admin = require("firebase-admin");
const cors = require("cors");
const dotenv = require("dotenv");
const Papa = require("papaparse");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

dotenv.config();

const app = express();

// Firebase credentials from environment variables
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

// Initialize Firebase Admin SDK only if it hasn’t been initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// Middleware
app.use(cors({ origin: "https://email-sender-1fae3.web.app" }));
// app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// Configure multer to use /tmp directory (Vercel-compatible)
const upload = multer({ dest: "/tmp" });

// AWS SES Client
const sesClient = new SESClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Fetch investor emails from Firestore
async function fetchInvestorEmails(listId) {
  if (!listId || listId === "No Recipients") return [];
  const listIds = listId.split(",").map((id) => id.trim());
  const emails = [];

  const chunks = [];
  for (let i = 0; i < listIds.length; i += 10) {
    chunks.push(listIds.slice(i, i + 10));
  }

  try {
    const investorsRef = db.collection("investors");
    for (const chunk of chunks) {
      const querySnapshot = await investorsRef
        .where("listId", "in", chunk)
        .get();
      if (!querySnapshot.empty) {
        querySnapshot.forEach((doc) => {
          const data = doc.data();
          if (data["Partner Email"]) {
            emails.push(data["Partner Email"]);
          }
        });
      }
    }
    return emails;
  } catch (error) {
    console.error("Error fetching investor emails:", error);
    return [];
  }
}

// Store email metadata in Firestore
async function storeSentEmailMetadata({
  campaignId,
  sender,
  recipientEmails,
  subject,
  sentAt,
}) {
  await db.collection("emailTracking").doc(campaignId).set(
    {
      sender,
      recipientEmails,
      subject,
      sentAt,
      sentCount: recipientEmails.length,
      openedCount: 0,
      bouncedCount: 0,
      spamCount: 0,
      unreadCount: recipientEmails.length,
      openedBy: [],
    },
    { merge: true }
  );
}

// Routes (unchanged logic, just ensuring compatibility)
app.post("/clients", async (req, res) => {
  try {
    const clientData = { ...req.body, createdAt: new Date() };
    const userRef = db.collection("clients").doc();
    await userRef.set(clientData);
    res
      .status(201)
      .json({ id: userRef.id, message: "Client added successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/campaign", async (req, res) => {
  try {
    const campaignData = { ...req.body, createdAt: new Date() };
    const campaignRef = db.collection("campaignLists").doc();
    await campaignRef.set(campaignData);
    res
      .status(201)
      .json({ id: campaignRef.id, message: "Campaign added successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/contact-lists", async (req, res) => {
  try {
    const { listName } = req.body;
    if (!listName || typeof listName !== "string") {
      return res.status(400).json({
        success: false,
        message: "listName is required and must be a string",
      });
    }
    const querySnapshot = await db
      .collection("contactLists")
      .where("listName", "==", listName)
      .get();
    if (!querySnapshot.empty) {
      return res.status(409).json({
        success: false,
        message: `A contact list with the name "${listName}" already exists`,
      });
    }
    const docRef = await db.collection("contactLists").add({
      listName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(201).json({
      success: true,
      message: "Contact list created successfully",
      id: docRef.id,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to save contact list",
      error: error.message,
    });
  }
});

app.post("/investors", async (req, res) => {
  try {
    const investorData = req.body;
    if (!Array.isArray(investorData) || investorData.length === 0) {
      return res
        .status(400)
        .json({ error: "Invalid request: Array of investor data is required" });
    }
    const createdIds = [];
    for (const investor of investorData) {
      if (!investor["Partner Email"] || !investor.listId) {
        return res
          .status(400)
          .json({ error: "Each investor must have partnerEmail and listId" });
      }
      const investorRef = db.collection("investors").doc();
      await investorRef.set(investor);
      createdIds.push(investorRef.id);
    }
    res.status(201).json({
      ids: createdIds,
      message: `Successfully added ${createdIds.length} investors`,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to add investors", details: error.message });
  }
});

app.post("/upload-csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { listId } = req.body;
  if (!listId) return res.status(400).json({ error: "listId is required" });

  try {
    const fileContent = await require("fs").promises.readFile(
      req.file.path,
      "utf-8"
    );
    const { data, errors } = Papa.parse(fileContent, {
      header: true,
      skipEmptyLines: true,
    });
    if (errors.length > 0) {
      return res
        .status(400)
        .json({ error: "Invalid CSV format", details: errors });
    }

    require("fs").unlink(req.file.path, (err) => {
      if (err) console.error("Error deleting temp file:", err);
    });

    const collectionRef = db.collection("investors");
    const batchSize = 500;
    let batch = db.batch();
    let counter = 0;

    for (let i = 0; i < data.length; i++) {
      const newDocRef = collectionRef.doc();
      batch.set(newDocRef, { listId, ...data[i] });
      counter++;
      if (counter === batchSize || i === data.length - 1) {
        await batch.commit();
        batch = db.batch();
        counter = 0;
      }
    }

    res.status(201).json({
      success: true,
      message: `CSV uploaded successfully! ${data.length} records inserted.`,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to upload CSV", details: error.message });
  }
});

// Get all users from Firestore
app.get("/clients", async (req, res) => {
  try {
    const { email } = req.query;

    let query = db.collection("clients");

    if (email) {
      query = query.where("email", "==", email);
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.json([]);
    }

    const clients = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/campaign", async (req, res) => {
  try {
    let query = db.collection("campaignLists");

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.json([]);
    }

    const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/campaign/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection("campaignLists").doc(id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    res.json({ id: docSnap.id, ...docSnap.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/contact-lists", async (req, res) => {
  try {
    const snapshot = await db.collection("contactLists").get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        message: "No contact lists found",
      });
    }

    // Map documents to include ID and data
    const contactLists = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({
      success: true,
      data: contactLists,
    });
  } catch (error) {
    console.error("Error fetching contact lists:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch contact lists",
      error: error.message,
    });
  }
});

app.get("/investors", async (req, res) => {
  try {
    // Get all documents from the investors collection
    const investorSnapshot = await db.collection("investors").get();

    if (investorSnapshot.empty) {
      return res.status(404).json({
        message: "No investors found",
        totalCount: 0,
        data: [],
      });
    }

    // Map the documents to an array of investor objects
    const investors = investorSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({
      message: "Successfully retrieved all investors",
      totalCount: investors.length,
      data: investors,
    });
  } catch (error) {
    console.error("Error retrieving investors:", error);
    res.status(500).json({
      error: "Failed to retrieve investors",
      details: error.message,
    });
  }
});

app.get("/stats", async (req, res) => {
  try {
    // Fetch the total number of clients
    const clientsSnapshot = await db.collection("clients").get();
    const clientCount = clientsSnapshot.size;

    // Fetch the total number of investor lists
    const investorListsSnapshot = await db.collection("investors").get();
    const investorListCount = investorListsSnapshot.size;

    const contactListsSnapshot = await db.collection("contactLists").get();
    const contactListCount = contactListsSnapshot.size;

    res.json({
      clients: clientCount,
      investorLists: investorListCount,
      totalContacts: contactListCount,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT endpoint to update an investor
app.put("/investors/:id", async (req, res) => {
  try {
    const investorId = req.params.id;
    const updateData = req.body;

    // Validate ID
    if (!investorId) {
      return res.status(400).json({
        error: "Investor ID is required",
      });
    }

    // Validate update data
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        error: "Update data is required",
      });
    }

    // Check for required fields if they're being updated
    if (updateData.partnerEmail === "" || updateData.listId === "") {
      return res.status(400).json({
        error: "partnerEmail and listId cannot be empty",
      });
    }

    // Reference to the investor document
    const investorRef = db.collection("investors").doc(investorId);

    // Check if document exists
    const doc = await investorRef.get();
    if (!doc.exists) {
      return res.status(404).json({
        error: "Investor not found",
      });
    }

    // Update the document
    await investorRef.update(updateData);

    res.status(200).json({
      message: `Successfully updated investor with ID: ${investorId}`,
      updatedFields: Object.keys(updateData),
    });
  } catch (error) {
    console.error("Error updating investor:", error);
    res.status(500).json({
      error: "Failed to update investor",
      details: error.message,
    });
  }
});

// DELETE API to remove a contact list and its related investor lists
app.delete("/contact-lists/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Contact list ID is required",
      });
    }

    // Reference to the contact list document
    const contactListRef = db.collection("contactLists").doc(id);

    // Check if the contact list exists
    const contactListDoc = await contactListRef.get();
    if (!contactListDoc.exists) {
      return res.status(404).json({
        success: false,
        message: `Contact list with ID ${id} not found`,
      });
    }

    // Start a batch for atomic deletion
    const batch = db.batch();

    // Delete the contact list
    batch.delete(contactListRef);

    // Delete all investor lists referencing this contact list
    const investorListsSnapshot = await db
      .collection("investors")
      .where("listRef", "==", contactListRef)
      .get();

    investorListsSnapshot.forEach((doc) => batch.delete(doc.ref));

    // Delete all investors associated with this contact list
    const investorsSnapshot = await db
      .collection("investors")
      .where("listId", "==", id)
      .get();

    investorsSnapshot.forEach((doc) => batch.delete(doc.ref));

    // Commit the batch operation
    await batch.commit();

    res.status(200).json({
      success: true,
      message: `Contact list ${id} deleted along with ${investorListsSnapshot.size} investor lists and ${investorsSnapshot.size} investors.`,
    });
  } catch (error) {
    console.error("Error deleting contact list:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete contact list and related data",
      error: error.message,
    });
  }
});

app.delete("/clients/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Reference to the document
    const userRef = db.collection("clients").doc(id);

    // Check if the document exists
    const doc = await userRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Client not found" });
    }

    // Delete the document
    await userRef.delete();

    res.status(200).json({ message: "Client deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE endpoint to remove an investor
app.delete("/investors/:id", async (req, res) => {
  try {
    const investorId = req.params.id;

    // Validate ID
    if (!investorId) {
      return res.status(400).json({
        error: "Investor ID is required",
      });
    }

    // Reference to the investor document
    const investorRef = db.collection("investors").doc(investorId);

    // Check if document exists
    const doc = await investorRef.get();
    if (!doc.exists) {
      return res.status(404).json({
        error: "Investor not found",
      });
    }

    // Delete the document
    await investorRef.delete();

    res.status(200).json({
      message: `Successfully deleted investor with ID: ${investorId}`,
    });
  } catch (error) {
    console.error("Error deleting investor:", error);
    res.status(500).json({
      error: "Failed to delete investor",
      details: error.message,
    });
  }
});

app.delete("/campaign/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection("campaignLists").doc(id);

    // Check if document exists before deleting
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: "Campaign not found",
      });
    }

    // Delete the document
    await docRef.delete();

    res.status(200).json({
      success: true,
      message: "Campaign deleted successfully",
      data: { id },
    });
  } catch (error) {
    console.error("Error deleting campaign:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete campaign",
      error: error.message,
    });
  }
});

// API to send email
// app.post("/send-email", async (req, res) => {
//   const { campaignId, content, recipients, sender, subject, topic } = req.body;

//   // Validate required fields
//   if (!campaignId || !content?.html || !recipients || !sender || !subject) {
//     return res.status(400).json({ message: "Missing required fields" });
//   }

//   // Fetch investor emails from Firestore
//   const recipientEmails = await fetchInvestorEmails(recipients);
//   if (recipientEmails.length === 0) {
//     return res
//       .status(400)
//       .json({ message: "No valid recipient emails found in Firestore" });
//   }

//   const params = {
//     Source: sender,
//     Destination: {
//       ToAddresses: recipientEmails, // Emails fetched from Firestore
//     },
//     Message: {
//       Subject: {
//         Data: subject,
//       },
//       Body: {
//         Html: {
//           Data: content.html, // HTML content from request
//         },
//       },
//     },
//   };

//   try {
//     const command = new SendEmailCommand(params);
//     const result = await sesClient.send(command);
//     res.status(200).json({
//       message: "Campaign email sent successfully",
//       campaignId,
//       recipients: recipientEmails,
//       result,
//     });
//   } catch (error) {
//     console.error("Error sending campaign email:", error);
//     res
//       .status(500)
//       .json({ message: "Failed to send campaign email", error: error.message });
//   }
// });

// Send Email with Tracking
app.post("/send-email", async (req, res) => {
  const { campaignId, content, recipients, sender, subject, topic } = req.body;

  if (!campaignId || !content?.html || !recipients || !sender || !subject) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const recipientEmails = await fetchInvestorEmails(recipients);
  if (recipientEmails.length === 0) {
    return res
      .status(400)
      .json({ message: "No valid recipient emails found in Firestore" });
  }

  const baseUrl =
    process.env.BASE_URL || "https://email-sender-server-rho.vercel.app";
  const results = [];

  try {
    // Send individual emails
    for (const recipient of recipientEmails) {
      const trackingPixel = `<img src="${baseUrl}/track-open?campaignId=${campaignId}&recipient=${encodeURIComponent(
        recipient
      )}" width="1" height="1" style="display:none;" />`;
      const emailContent = `${content.html}${trackingPixel}`;

      const params = {
        Source: sender,
        Destination: {
          ToAddresses: [recipient], // One email per recipient
        },
        Message: {
          Subject: {
            Data: subject,
          },
          Body: {
            Html: {
              Data: emailContent,
            },
          },
        },
        Tags: [{ Name: "campaignId", Value: campaignId }],
      };

      const command = new SendEmailCommand(params);
      const result = await sesClient.send(command);
      results.push(result);
    }

    await storeSentEmailMetadata({
      campaignId,
      sender,
      recipientEmails,
      subject,
      sentAt: new Date().toISOString(),
    });

    res.status(200).json({
      message: "Campaign emails sent successfully",
      campaignId,
      recipients: recipientEmails,
      results,
    });
  } catch (error) {
    console.error("Error sending campaign emails:", error);
    res.status(500).json({
      message: "Failed to send campaign emails",
      error: error.message,
    });
  }
});

// Track Email Opens
app.get("/track-open", async (req, res) => {
  const { campaignId, recipient } = req.query;

  if (!campaignId) {
    return res.status(400).json({ message: "campaignId is required" });
  }

  try {
    const emailDocRef = db.collection("emailTracking").doc(campaignId);
    const emailDoc = await emailDocRef.get();

    if (!emailDoc.exists) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    const data = emailDoc.data();
    const openedBy = data.openedBy || [];

    // If recipient is provided and hasn’t opened it yet
    if (recipient && !openedBy.includes(recipient)) {
      await emailDocRef.update({
        openedCount: admin.firestore.FieldValue.increment(1),
        unreadCount: admin.firestore.FieldValue.increment(-1),
        openedBy: admin.firestore.FieldValue.arrayUnion(recipient),
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error tracking email open:", error);
    res.sendStatus(500);
  }
});

// SNS Endpoint for Bounce/Spam Events
app.post("/sns-email-events", async (req, res) => {
  const message = JSON.parse(req.body.Message || "{}");

  if (message.eventType === "Bounce") {
    const campaignId = message.mail?.tags?.campaignId?.[0];
    if (campaignId) {
      await db
        .collection("emailTracking")
        .doc(campaignId)
        .update({
          bouncedCount: admin.firestore.FieldValue.increment(1),
        });
    }
  } else if (message.eventType === "Complaint") {
    const campaignId = message.mail?.tags?.campaignId?.[0];
    if (campaignId) {
      await db
        .collection("emailTracking")
        .doc(campaignId)
        .update({
          spamCount: admin.firestore.FieldValue.increment(1),
        });
    }
  }

  res.sendStatus(200);
});

// GET Stats for a Single Campaign
app.get("/email-stats/:campaignId", async (req, res) => {
  const { campaignId } = req.params;

  try {
    const doc = await db.collection("emailTracking").doc(campaignId).get();
    if (!doc.exists) {
      return res.status(404).json({ message: "Campaign stats not found" });
    }

    const data = doc.data();
    res.status(200).json({
      campaignId,
      sender: data.sender,
      subject: data.subject,
      sentAt: data.sentAt,
      stats: {
        sent: data.sentCount || 0,
        opened: data.openedCount || 0,
        bounced: data.bouncedCount || 0,
        spammed: data.spamCount || 0,
        unread: data.unreadCount || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching email stats:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch stats", error: error.message });
  }
});

// New GET API to Retrieve All Email Stats
app.get("/email-stats", async (req, res) => {
  try {
    const snapshot = await db.collection("emailTracking").get();

    if (snapshot.empty) {
      return res.status(200).json({
        message: "No email campaigns found",
        totalCampaigns: 0,
        data: [],
      });
    }

    const campaigns = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        campaignId: doc.id,
        sender: data.sender,
        subject: data.subject,
        sentAt: data.sentAt,
        stats: {
          sent: data.sentCount || 0,
          opened: data.openedCount || 0,
          bounced: data.bouncedCount || 0,
          spammed: data.spamCount || 0,
          unread: data.unreadCount || 0,
        },
      };
    });

    res.status(200).json({
      message: "Successfully retrieved all email stats",
      totalCampaigns: campaigns.length,
      data: campaigns,
    });
  } catch (error) {
    console.error("Error fetching all email stats:", error);
    res.status(500).json({
      message: "Failed to fetch all email stats",
      error: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.send("Welcome to the Email Campaign API!");
});

module.exports = app;
