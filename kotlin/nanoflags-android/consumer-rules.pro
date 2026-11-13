# NanoFlags uses no reflection: R8 keeps what the app calls and strips the rest, including every part of
# BouncyCastle except the lightweight Ed25519 verifier. BouncyCastle references optional JDK classes (javax.naming,
# java.awt…) from code that NanoFlags never reaches.
-dontwarn org.bouncycastle.**
