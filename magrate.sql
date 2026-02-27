-- Run this if you already deployed the schema and need to add the unique constraint
ALTER TABLE fuel_prices ADD CONSTRAINT IF NOT EXISTS 
  fuel_prices_owner_pump_date UNIQUE (owner_id, pump_id, effective_date);