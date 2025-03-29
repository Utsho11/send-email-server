const express = require("express");
const multer = require("multer");
const fs = require("fs");
const admin = require("firebase-admin");
const cors = require("cors");
const dotenv = require("dotenv");
const Papa = require("papaparse");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

dotenv.config();

const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(cors("https://email-sender-1fae3.web.app"));
app.use(express.json());
const upload = multer({ dest: "uploads/" });
// Create a new document in Firestore

const sesClient = new SESClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function fetchInvestorEmails(listId) {
  if (!listId || listId === "No Recipients") return [];
  const listIds = listId.split(",").map((id) => id.trim());
  const emails = [];

  // Batch listIds into chunks of 10 (Firestore 'in' limit)
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
            // Use exact field name from your object
            emails.push(data["Partner Email"]);
          }
        });
      }
    }

    if (emails.length === 0) {
      console.log("No partner emails found for listIds:", listIds);
    }

    return emails;
  } catch (error) {
    console.error("Error fetching investor emails:", error);
    return [];
  }
}

app.post("/clients", async (req, res) => {
  try {
    // Create client object
    const clientData = {
      ...req.body,
      createdAt: new Date(),
    };

    // Add to Firestore
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
    // Create client object
    const campaignData = {
      ...req.body,
      createdAt: new Date(),
    };

    // Add to Firestore
    const campaignRef = db.collection("campaignLists").doc();
    await campaignRef.set(campaignData);

    res.status(201).json({
      id: campaignRef.id,
      message: "Campaign added successfully",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/contact-lists", async (req, res) => {
  try {
    const { listName } = req.body;

    // Validate input
    if (!listName || typeof listName !== "string") {
      return res.status(400).json({
        success: false,
        message: "listName is required and must be a string",
      });
    }

    // Check if listName already exists
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

    // Save to Firestore if unique
    const docRef = await db.collection("contactLists").add({
      listName: listName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Respond with success
    res.status(201).json({
      success: true,
      message: "Contact list created successfully",
      id: docRef.id,
    });
  } catch (error) {
    console.error("Error saving listName:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save contact list",
      error: error.message,
    });
  }
});

app.post("/investors", async (req, res) => {
  try {
    // Get the array of investor data from request body
    const investorData = req.body;

    // Validate input
    if (!Array.isArray(investorData) || investorData.length === 0) {
      return res.status(400).json({
        error: "Invalid request: Array of investor data is required",
      });
    }

    // Array to store created document IDs
    const createdIds = [];

    // Write each investor as a separate document
    for (const investor of investorData) {
      // Validate each investor object
      if (!investor["Partner Email"] || !investor.listId) {
        return res.status(400).json({
          error: "Each investor must have partnerEmail and listId",
        });
      }

      const investorRef = db.collection("investors").doc();
      await investorRef.set(investor);
      createdIds.push(investorRef.id);
    }

    // Send success response
    res.status(201).json({
      ids: createdIds,
      message: `Successfully added ${createdIds.length} investors`,
    });
  } catch (error) {
    console.error("Error adding investors:", error);
    res.status(500).json({
      error: "Failed to add investors",
      details: error.message,
    });
  }
});

app.post("/upload-csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const { listId } = req.body; // Extract list ID

  if (!listId) {
    return res.status(400).json({ error: "listid is required" });
  }

  try {
    // Read CSV file
    const fileContent = await fs.promises.readFile(req.file.path, "utf-8");

    // Parse CSV using PapaParse
    const { data, errors } = Papa.parse(fileContent, {
      header: true,
      skipEmptyLines: true,
    });

    if (errors.length > 0) {
      return res
        .status(400)
        .json({ error: "Invalid CSV format", details: errors });
    }

    // Delete temp file asynchronously (non-blocking)
    fs.unlink(req.file.path, (err) => {
      if (err) console.error("Error deleting temp file:", err);
    });

    const collectionRef = db.collection("investors");
    const batchSize = 500; // Firestore supports max 500 operations per batch
    let batch = db.batch();
    let counter = 0;

    for (let i = 0; i < data.length; i++) {
      const newDocRef = collectionRef.doc(); // Generate a new document ID
      batch.set(newDocRef, { listId: listId, ...data[i] }); // Add to batch
      counter++;

      // If batch size reaches limit, commit and create a new batch
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
    console.error("Error processing CSV upload:", error);
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
app.post("/send-email", async (req, res) => {
  const { campaignId, content, recipients, sender, subject, topic } = req.body;

  // Validate required fields
  if (!campaignId || !content?.html || !recipients || !sender || !subject) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  // Fetch investor emails from Firestore
  const recipientEmails = await fetchInvestorEmails(recipients);
  if (recipientEmails.length === 0) {
    return res
      .status(400)
      .json({ message: "No valid recipient emails found in Firestore" });
  }

  const params = {
    Source: sender,
    Destination: {
      ToAddresses: recipientEmails, // Emails fetched from Firestore
    },
    Message: {
      Subject: {
        Data: subject,
      },
      Body: {
        Html: {
          Data: content.html, // HTML content from request
        },
      },
    },
  };

  try {
    const command = new SendEmailCommand(params);
    const result = await sesClient.send(command);
    res.status(200).json({
      message: "Campaign email sent successfully",
      campaignId,
      recipients: recipientEmails,
      result,
    });
  } catch (error) {
    console.error("Error sending campaign email:", error);
    res
      .status(500)
      .json({ message: "Failed to send campaign email", error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
