CREATE DATABASE IF NOT EXISTS Encora_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE Encora_db;

-- Hapus tabel lama (urutan penting karena ada foreign key)
DROP TABLE IF EXISTS message_hidden;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(30) NOT NULL UNIQUE,
    username VARCHAR(100) NOT NULL,
    -- email, password, dan access_key disimpan sebagai string bit (0/1),
    -- 10 bit per karakter, jadi kolomnya dibuat panjang & ASCII.
    -- (VARCHAR(150) lama hanya muat email 15 karakter.)
    email VARCHAR(1500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    password TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    access_key TEXT CHARACTER SET ascii COLLATE ascii_bin NULL,
    ip_address VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL
);

CREATE TABLE messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sender_id VARCHAR(30) NOT NULL,
    sender_name VARCHAR(100) NOT NULL,
    receiver_id VARCHAR(30) NOT NULL,
    message LONGBLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sender (sender_id),
    INDEX idx_receiver (receiver_id),
    FOREIGN KEY (sender_id) REFERENCES users(user_id),
    FOREIGN KEY (receiver_id) REFERENCES users(user_id)
);

-- Pesan yang dihapus oleh pengguna (hapus untuk saya, teman tetap melihat pesannya)
CREATE TABLE message_hidden (
    user_id VARCHAR(30) NOT NULL,
    message_id INT NOT NULL,
    PRIMARY KEY (user_id, message_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
