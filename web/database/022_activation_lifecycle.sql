-- Activation authorization follows the account status and binding that existed at issuance.
CREATE TRIGGER retire_user_activation_codes
AFTER UPDATE OF binding_version, role, status ON users
WHEN NEW.binding_version IS NOT OLD.binding_version
  OR NEW.role IS NOT OLD.role
  OR NEW.status IS NOT OLD.status
BEGIN
  UPDATE activation_tokens
  SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE actor = OLD.actor AND consumed_at IS NULL;
END;

CREATE TRIGGER retire_partner_activation_codes
AFTER UPDATE OF data, status ON accounts
WHEN NEW.status IS NOT OLD.status
  OR json_extract(NEW.data, '$.bindingVersion') IS NOT json_extract(OLD.data, '$.bindingVersion')
BEGIN
  UPDATE activation_tokens
  SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE actor = json_extract(OLD.data, '$.actor') AND consumed_at IS NULL;
END;
