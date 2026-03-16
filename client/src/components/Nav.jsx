import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./Nav.css";

export default function Nav() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Get current page name for the logo (matches original navname)
  const pageNames = {
    "/forecast": "Forecast",
    "/sencrop": "Sencrop",
    "/fields": "Fields",
    "/gps": "Gps",
    "/phyto": "Phyto",
  };
  const currentName = pageNames[location.pathname] || "Farm";

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  // Match original: active link gets 'highlight' class
  const linkClass = ({ isActive }) => (isActive ? "link highlight" : "link");

  return (
    <header>
      <h1 id="logo">{currentName}</h1>
      <nav>
        <ul className="nav_links">
          <li>
            <NavLink className={linkClass} to="/forecast">
              Forecast
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/sencrop">
              Sencrop
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/fields">
              Fields
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/gps">
              Gps
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/phyto">
              Phyto
            </NavLink>
          </li>
        </ul>
      </nav>
      <a
        className="cta"
        id="deco"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          handleLogout();
        }}
      >
        Log out
      </a>
    </header>
  );
}
