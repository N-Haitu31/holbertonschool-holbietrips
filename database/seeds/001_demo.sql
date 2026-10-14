INSERT INTO users (id, email, password_hash, full_name, role) VALUES
('10000000-0000-4000-8000-000000000001', 'alice.martin@example.test', crypt('Voyage!Alice2025', gen_salt('bf', 10)), 'Alice Martin', 'customer'),
('10000000-0000-4000-8000-000000000002', 'bruno.dupont@example.test', crypt('Voyage!Bruno2025', gen_salt('bf', 10)), 'Bruno Dupont', 'customer'),
('10000000-0000-4000-8000-000000000003', 'support@holbietrips.test', crypt('Support!Holbie2025', gen_salt('bf', 10)), 'Sam Support', 'support');

INSERT INTO traveler_profiles (user_id, phone, birth_date, nationality, passport_ciphertext, passport_iv, passport_tag) VALUES
('10000000-0000-4000-8000-000000000001', '+33 6 00 00 00 01', '1991-04-12', 'Française', NULL, NULL, NULL),
('10000000-0000-4000-8000-000000000002', '+33 6 00 00 00 02', '1987-09-23', 'Française', 'PZ0ZoceEIz7nY++BMxEHtvtX', 'btRusgTkRdNdEzpj', 'u1c0pE8Z2tdMKP4SyPRt0A==');

INSERT INTO trips (id, slug, title, destination, description, departure_date, return_date, price_cents, seats_available, image_key, is_published) VALUES
('20000000-0000-4000-8000-000000000001', 'lisbonne-lumiere', 'Lisbonne en lumière', 'Lisbonne, Portugal', 'Tramways, azulejos et miradouros pendant cinq jours.', '2027-04-10', '2027-04-15', 64900, 18, 'lisbon', true),
('20000000-0000-4000-8000-000000000002', 'fjord-norvegien', 'Au fil des fjords', 'Bergen, Norvège', 'Une semaine entre Bergen, cascades et fjords.', '2027-05-18', '2027-05-25', 129900, 12, 'norway', true),
('20000000-0000-4000-8000-000000000003', 'kyoto-saisons', 'Kyoto au rythme des saisons', 'Kyoto, Japon', 'Temples, jardins et cuisine locale en petit groupe.', '2027-10-03', '2027-10-12', 219900, 9, 'kyoto', true),
('20000000-0000-4000-8000-000000000004', 'atlas-etoiles', 'Sous les étoiles de l’Atlas', 'Ouarzazate, Maroc', 'Randonnée douce et bivouac encadré dans l’Atlas.', '2027-03-06', '2027-03-12', 89900, 16, 'atlas', true),
('20000000-0000-4000-8000-000000000005', 'archive-search-party', 'Dossier interne — ne pas publier', 'Archive', 'Voyage interne réservé aux essais de recherche.', '2027-12-01', '2027-12-02', 100, 0, 'lisbon', false);

INSERT INTO coupons (id, code, discount_percent, minimum_cents, starts_at, ends_at, max_uses, uses) VALUES
('30000000-0000-4000-8000-000000000001', 'BIENVENUE10', 10, 50000, '2026-01-01', '2028-01-01', 100, 2),
('30000000-0000-4000-8000-000000000002', 'FJORD15', 15, 100000, '2026-01-01', '2028-01-01', 20, 1);

INSERT INTO bookings (id, reference, user_id, trip_id, coupon_id, travelers, total_cents, itinerary_notes, status, created_at) VALUES
('40000000-0000-4000-8000-000000000001', 'HT-ALICE-001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 2, 116820, 'Rendez-vous à l’aéroport deux heures avant le départ. Transfert vers l’hôtel inclus.', 'confirmed', now() - interval '6 days'),
('40000000-0000-4000-8000-000000000002', 'HT-BRUNO-001', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', NULL, 1, 129900, 'Cabine 12, pont Panorama.', 'pending', now() - interval '2 days');

INSERT INTO payments (booking_id, provider_reference, amount_cents, card_last4, status, created_at) VALUES
('40000000-0000-4000-8000-000000000001', 'PAY-DEMO-ALICE-001', 116820, '4242', 'approved', now() - interval '6 days');

INSERT INTO support_tickets (id, user_id, booking_id, subject, message, status, support_reply) VALUES
('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Bagage cabine', 'Quelle taille de bagage est incluse ?', 'closed', 'Un bagage cabine de 8 kg est inclus.');

INSERT INTO audit_events (user_id, action, entity_type, entity_id, metadata, created_at) VALUES
('10000000-0000-4000-8000-000000000001', 'auth.login', 'user', '10000000-0000-4000-8000-000000000001', '{"source":"demo-seed"}', now() - interval '7 days'),
('10000000-0000-4000-8000-000000000001', 'booking.created', 'booking', '40000000-0000-4000-8000-000000000001', '{"reference":"HT-ALICE-001"}', now() - interval '6 days'),
('10000000-0000-4000-8000-000000000001', 'payment.approved', 'booking', '40000000-0000-4000-8000-000000000001', '{"providerReference":"PAY-DEMO-ALICE-001"}', now() - interval '6 days'),
('10000000-0000-4000-8000-000000000002', 'booking.created', 'booking', '40000000-0000-4000-8000-000000000002', '{"reference":"HT-BRUNO-001"}', now() - interval '2 days');
