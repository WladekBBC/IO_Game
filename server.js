require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const os = require("os");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Middleware do parsowania JSON
app.use(express.json());

// Konfiguracja połączenia z MySQL
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "escape_room_game",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

// Utwórz pulę połączeń
const pool = mysql.createPool(dbConfig);

// Flaga do śledzenia statusu bazy danych
let dbReady = false;

// Funkcja do inicjalizacji bazy danych (nie blokuje startowania serwera)
async function initDatabase() {
  try {
    const connection = await pool.getConnection();

    // Utwórz tabelę jeśli nie istnieje
    await connection.query(`
      CREATE TABLE IF NOT EXISTS scores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        team_name VARCHAR(255) NOT NULL,
        score INT NOT NULL,
        time_seconds INT NOT NULL,
        mode VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_score (score DESC),
        INDEX idx_time (time_seconds ASC),
        INDEX idx_created (created_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    connection.release();
    dbReady = true;
    console.log("✓ Baza danych zainicjalizowana");
  } catch (error) {
    console.error("⚠️ Baza danych niedostępna - gra będzie działać bez rankingu:", error.message);
    dbReady = false;
    // Nie przerywaj działania serwera
  }
}

// Inicjalizuj bazę danych w tle (nie czekaj)
initDatabase().catch(() => {
  console.log("Kontynuuję bez bazy danych...");
});

// Middleware CORS dla wszystkich żądań
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Endpoint testowy PRZED Socket.io
app.get("/health", (req, res) => {
  console.log("GET /health - zwracam odpowiedź");
  res.json({ status: "ok", port: PORT, timestamp: new Date().toISOString() });
});

// API - Zapisz wynik
app.post("/api/scores", async (req, res) => {
  try {
    const { teamName, score, time, mode } = req.body;

    if (!teamName || score === undefined || time === undefined || !mode) {
      return res.status(400).json({ error: "Brakuje wymaganych pól" });
    }

    // Jeśli baza danych nie jest dostępna, zwróć sukces (dane zostaną zapisane gdy DB będzie gotowa)
    if (!dbReady) {
      console.log("DB niedostępna - wynik nie został zapisany w bazie");
      return res.json({
        success: true,
        id: null,
        message: "Wynik przesłany (baza niedostępna, ranking niedostępny)",
      });
    }

    const [result] = await pool.query(
      "INSERT INTO scores (team_name, score, time_seconds, mode) VALUES (?, ?, ?, ?)",
      [teamName, score, time, mode]
    );

    res.json({
      success: true,
      id: result.insertId,
      message: "Wynik zapisany",
    });
  } catch (error) {
    console.error("Błąd zapisywania wyniku:", error);
    res.json({
      success: true,
      id: null,
      message: "Wynik przesłany (błąd bazy danych, ranking niedostępny)",
    });
  }
});

// API - Pobierz ranking
app.get("/api/scores", async (req, res) => {
  try {
    if (!dbReady) {
      return res.json({
        success: true,
        scores: [],
        message: "Ranking niedostępny - baza danych nie jest połączona",
      });
    }

    const { sort = "score" } = req.query;

    let orderBy = "score DESC";
    if (sort === "time") {
      orderBy = "time_seconds ASC";
    } else if (sort === "date") {
      orderBy = "created_at DESC";
    }

    const [rows] = await pool.query(
      `SELECT id, team_name, score, time_seconds, mode, created_at 
       FROM scores 
       ORDER BY ${orderBy} 
       LIMIT 100`
    );

    // Formatuj wyniki
    const scores = rows.map((row) => ({
      id: row.id,
      teamName: row.team_name,
      score: row.score,
      time: row.time_seconds,
      mode: row.mode,
      date: row.created_at.toISOString(),
    }));

    res.json({ success: true, scores });
  } catch (error) {
    console.error("Błąd pobierania wyników:", error);
    res.json({
      success: true,
      scores: [],
      message: "Ranking niedostępny - błąd bazy danych",
    });
  }
});

// Middleware do logowania wszystkich żądań (tylko dla debugowania)
app.use((req, res, next) => {
  if (!req.url.startsWith("/socket.io/")) {
    console.log(`${req.method} ${req.url}`);
  }
  next();
});

// Przekieruj główną ścieżkę do index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Serwuj pliki statyczne
app.use(express.static(__dirname));

// Konfiguracja Socket.io - TYLKO dla ścieżki /socket.io/

const io = new Server(server, {
  // Użyj standardowej ścieżki bez końcowego slasha — prostsze dopasowanie klienta
  path: "/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    // przy origin: '*' nie ustawiamy credentials na true
    credentials: false,
  },
  transports: ["websocket", "polling"],
  // ping/connect timeouts dostosowane do niestabilnych sieci lokalnych
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  // Łatwiej połączyć się z sieci lokalnej
  allowEIO3: true,
});

// Logowanie połączeń dla debugowania
io.engine.on("connection_error", (err) => {
  console.error("Błąd połączenia Socket.io:", err);
});

// Przechowuj pokoje multiplayer
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("Użytkownik połączony:", socket.id);

  // Utwórz pokój
  socket.on("createRoom", ({ teamName }) => {
    const roomId = generateRoomId();
    rooms.set(roomId, {
      host: {
        id: socket.id,
        teamName,
        score: 0,
        time: 0,
        finished: false,
        finishTimestamp: null,
      },
      guest: null,
      started: false,
    });

    socket.join(roomId);
    socket.emit("roomCreated", { roomId });
    console.log(`Pokój utworzony: ${roomId} przez ${teamName}`);
  });

  // Dołącz do pokoju
  socket.on("joinRoom", ({ roomId, teamName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("error", { message: "Pokój nie istnieje" });
      return;
    }

    if (room.guest) {
      socket.emit("error", { message: "Pokój jest pełny" });
      return;
    }

    room.guest = {
      id: socket.id,
      teamName,
      score: 0,
      time: 0,
      finished: false,
      finishTimestamp: null,
    };

    socket.join(roomId);
    socket.emit("roomJoined", { roomId });

    // Powiadom hosta o dołączeniu gościa
    io.to(room.host.id).emit("opponentJoined", {
      opponentName: teamName,
    });

    // Powiadom gościa o hostcie
    socket.emit("opponentJoined", {
      opponentName: room.host.teamName,
    });

    console.log(`${teamName} dołączył do pokoju ${roomId}`);
  });

  // Rozpocznij grę (tylko host może)
  socket.on("startGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host.id !== socket.id) {
      return;
    }

    if (!room.guest) {
      socket.emit("error", { message: "Czekaj na przeciwnika" });
      return;
    }

    room.started = true;
    io.to(roomId).emit("gameStart");
    console.log(`Gra rozpoczęta w pokoju ${roomId}`);
  });

  // Aktualizacja wyniku
  socket.on("scoreUpdate", ({ roomId, score }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Zaktualizuj wynik gracza
    if (room.host.id === socket.id) {
      room.host.score = score;
      // Wyślij do gościa
      if (room.guest) {
        io.to(room.guest.id).emit("opponentUpdate", {
          score: room.host.score,
        });
      }
    } else if (room.guest && room.guest.id === socket.id) {
      room.guest.score = score;
      // Wyślij do hosta
      io.to(room.host.id).emit("opponentUpdate", {
        score: room.guest.score,
      });
    }
  });

  // Gra zakończona
  socket.on("gameFinished", ({ roomId, teamName, score, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const finishTime = Date.now(); // Czas zakończenia w milisekundach

    // Zapisz wynik gracza
    if (room.host.id === socket.id) {
      room.host.score = score;
      room.host.time = time; // Czas w sekundach
      room.host.finished = true;
      room.host.finishTimestamp = finishTime;
      room.host.teamName = teamName;
    } else if (room.guest && room.guest.id === socket.id) {
      room.guest.score = score;
      room.guest.time = time; // Czas w sekundach
      room.guest.finished = true;
      room.guest.finishTimestamp = finishTime;
      room.guest.teamName = teamName;
    }

    // Sprawdź, czy obie drużyny ukończyły
    const bothFinished =
      room.host.finished && room.guest && room.guest.finished;

    if (bothFinished) {
      // Obie drużyny ukończyły - określ zwycięzcę
      let winner = null;
      let reason = "";

      if (room.host.score > room.guest.score) {
        winner = "host";
        reason = "Więcej punktów";
      } else if (room.guest.score > room.host.score) {
        winner = "guest";
        reason = "Więcej punktów";
      } else {
        // Remis punktów - wygrywa szybsza drużyna (mniejszy czas)
        if (room.host.time < room.guest.time) {
          winner = "host";
          reason = "Równe punkty, szybszy czas";
        } else if (room.guest.time < room.host.time) {
          winner = "guest";
          reason = "Równe punkty, szybszy czas";
        } else {
          winner = "draw";
          reason = "Pełny remis";
        }
      }

      // Wyślij wyniki do obu graczy
      const hostResult = {
        myScore: room.host.score,
        myTime: room.host.time,
        opponentScore: room.guest.score,
        opponentTime: room.guest.time,
        opponentName: room.guest.teamName,
        isWinner: winner === "host",
        isDraw: winner === "draw",
        reason: reason,
      };

      const guestResult = {
        myScore: room.guest.score,
        myTime: room.guest.time,
        opponentScore: room.host.score,
        opponentTime: room.host.time,
        opponentName: room.host.teamName,
        isWinner: winner === "guest",
        isDraw: winner === "draw",
        reason: reason,
      };

      io.to(room.host.id).emit("gameResult", hostResult);
      io.to(room.guest.id).emit("gameResult", guestResult);

      console.log(
        `Gra zakończona w pokoju ${roomId}. Zwycięzca: ${
          winner === "host"
            ? room.host.teamName
            : winner === "guest"
            ? room.guest.teamName
            : "remis"
        }`
      );
    } else {
      // Tylko jedna drużyna ukończyła - powiadom przeciwnika, że czeka
      const opponent = room.host.id === socket.id ? room.guest : room.host;
      if (opponent) {
        io.to(opponent.id).emit("opponentFinished", {
          teamName,
          score,
          time,
          waiting: true, // Oznacz, że czekamy na drugą drużynę
        });
      }
    }
  });

  // Rozłączenie
  socket.on("disconnect", () => {
    console.log("Użytkownik rozłączony:", socket.id);

    // Usuń pokój jeśli host się rozłączył
    for (const [roomId, room] of rooms.entries()) {
      if (room.host.id === socket.id) {
        if (room.guest) {
          io.to(room.guest.id).emit("hostDisconnected");
        }
        rooms.delete(roomId);
        console.log(`Pokój ${roomId} usunięty (host rozłączony)`);
        break;
      } else if (room.guest && room.guest.id === socket.id) {
        room.guest = null;
        io.to(room.host.id).emit("opponentLeft");
        console.log(`Gość opuścił pokój ${roomId}`);
        break;
      }
    }
  });
});

// Generuj losowe ID pokoju (6 znaków)
function generateRoomId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Znajdź lokalny IP adres
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

const localIp = getLocalIp();

// Bind na konkretnym IP zamiast 0.0.0.0 (lepiej na macOS)
server.listen(PORT, localIp, () => {
  console.log(`✅ Serwer działa!`);
  console.log(`Localhost: http://localhost:${PORT}`);
  if (localIp !== "localhost") {
    console.log(`Sieć lokalna: http://${localIp}:${PORT}`);
    console.log(`Socket.io: ws://${localIp}:${PORT}/socket.io/`);
  }
  console.log(`Test: http://${localIp}:${PORT}/health`);
});

// Obsługa błędów serwera (np. EADDRINUSE)
server.on("error", (err) => {
  console.error("Błąd serwera:", err);
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} jest już używany. Zakończ proces lub zmień PORT.`
    );
  }
});
