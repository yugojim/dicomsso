from functools import lru_cache
from typing import Any
import httpx
from fastapi import Cookie, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt, JWTError
from .config import settings

bearer = HTTPBearer(auto_error=False)

@lru_cache(maxsize=1)
def get_jwks() -> dict[str, Any]:
    r = httpx.get(settings.keycloak_jwks_url, timeout=10)
    r.raise_for_status()
    return r.json()

def _extract_roles(payload: dict[str, Any]) -> set[str]:
    roles: set[str] = set(payload.get("realm_access", {}).get("roles", []))
    resource_access = payload.get("resource_access", {})
    for client_data in resource_access.values():
        roles.update(client_data.get("roles", []))
    return roles

def _allowed_issuers() -> set[str]:
    configured = [settings.keycloak_issuer, *settings.keycloak_allowed_issuers.split(",")]
    return {issuer.strip().rstrip("/") for issuer in configured if issuer.strip()}

def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    kc_token: str | None = Cookie(default=None),
) -> dict[str, Any]:
    token = credentials.credentials if credentials else kc_token
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")

    try:
        payload = jwt.decode(
            token,
            get_jwks(),
            algorithms=["RS256"],
            options={"verify_aud": False, "verify_iss": False},
        )
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {exc}")

    issuer = str(payload.get("iss", "")).rstrip("/")
    if issuer not in _allowed_issuers():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token issuer: {issuer}")

    tenant_id = payload.get(settings.tenant_claim)
    if not tenant_id:
        # Development fallback: allows testing before tenant_id mapper is added in Keycloak.
        tenant_id = payload.get("preferred_username") or payload.get("sub")

    roles = _extract_roles(payload)
    return {
        "sub": payload.get("sub"),
        "username": payload.get("preferred_username", payload.get("email", "unknown")),
        "email": payload.get("email"),
        "tenant_id": tenant_id,
        "roles": roles,
        "raw": payload,
    }

def require_role(*allowed: str):
    def checker(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
        if "admin" in user["roles"] or any(role in user["roles"] for role in allowed):
            return user
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    return checker
