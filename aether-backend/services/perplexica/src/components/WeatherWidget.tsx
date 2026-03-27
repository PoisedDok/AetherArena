import { Cloud, Sun, CloudRain, CloudSnow, Wind } from 'lucide-react';
import { useEffect, useState } from 'react';

const WeatherWidget = () => {
  const [data, setData] = useState({
    temperature: 0,
    condition: '',
    location: '',
    humidity: 0,
    windSpeed: 0,
    icon: '',
    temperatureUnit: 'C',
    windSpeedUnit: 'm/s',
  });

  const [loading, setLoading] = useState(true);

  const getApproxLocation = async () => {
    try {
      const res = await fetch('https://ipwhois.app/json/');
      if (!res.ok) throw new Error('Failed to fetch IP location');
      const data = await res.json();

      if (!data.success && data.latitude === undefined) {
          throw new Error('IP location API returned error: ' + JSON.stringify(data));
      }

      return {
        latitude: data.latitude,
        longitude: data.longitude,
        city: data.city || 'Unknown',
      };
    } catch (e) {
      console.error('IP location failed:', e);
      // Fallback location if everything fails (e.g. London as default)
      return { latitude: 51.5074, longitude: -0.1278, city: 'London' };
    }
  };

  const getLocation = async (
    callback: (location: {
      latitude: number;
      longitude: number;
      city: string;
    }) => void,
  ) => {
    try {
      if (navigator.geolocation) {
        let result;
        try {
          result = await navigator.permissions.query({
            name: 'geolocation',
          });
        } catch (e) {
          console.warn('Permissions query failed, falling back to approx location', e);
        }

        if (result && result.state === 'granted') {
          navigator.geolocation.getCurrentPosition(async (position) => {
            try {
              const res = await fetch(
                `https://api-bdc.io/data/reverse-geocode-client?latitude=${position.coords.latitude}&longitude=${position.coords.longitude}&localityLanguage=en`,
                {
                  method: 'GET',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                },
              );

              const data = await res.json();

              callback({
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                city: data.locality || 'Unknown',
              });
            } catch (e) {
              console.error('Reverse geocode failed:', e);
              callback(await getApproxLocation());
            }
          });
        } else if (result && result.state === 'prompt') {
          callback(await getApproxLocation());
          navigator.geolocation.getCurrentPosition((position) => {});
        } else {
          callback(await getApproxLocation());
        }
      } else {
        callback(await getApproxLocation());
      }
    } catch (error) {
      console.error('Location error:', error);
      callback(await getApproxLocation());
    }
  };

  const updateWeather = async () => {
    try {
      getLocation(async (location) => {
        try {
          const res = await fetch(`/api/weather`, {
            method: 'POST',
            body: JSON.stringify({
              lat: location.latitude,
              lng: location.longitude,
              measureUnit: localStorage.getItem('measureUnit') ?? 'Metric',
            }),
          });

          const data = await res.json();

          if (res.status !== 200) {
            console.error('Error fetching weather data', data);
            setLoading(false);
            return;
          }

          setData({
            temperature: data.temperature,
            condition: data.condition,
            location: location.city,
            humidity: data.humidity,
            windSpeed: data.windSpeed,
            icon: data.icon,
            temperatureUnit: data.temperatureUnit,
            windSpeedUnit: data.windSpeedUnit,
          });
          setLoading(false);
        } catch (e) {
          console.error('Failed to fetch weather API:', e);
          setLoading(false);
        }
      });
    } catch (e) {
      console.error('Outer updateWeather error:', e);
      setLoading(false);
    }
  };

  useEffect(() => {
    updateWeather();
    const intervalId = setInterval(updateWeather, 30 * 1000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="glass-panel rounded-2xl border border-light-200 dark:border-dark-200 shadow-sm shadow-light-200/10 dark:shadow-black/25 flex flex-row items-center w-full h-24 min-h-[96px] max-h-[96px] px-3 py-2 gap-3">
      {loading ? (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full animate-pulse">
            <div className="h-10 w-10 rounded-full glass-panel mb-2" />
            <div className="h-4 w-10 rounded glass-panel" />
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-1 animate-pulse">
            <div className="flex flex-row items-center justify-between">
              <div className="h-3 w-20 rounded glass-panel" />
              <div className="h-3 w-12 rounded glass-panel" />
            </div>
            <div className="h-3 w-16 rounded glass-panel mt-1" />
            <div className="flex flex-row justify-between w-full mt-auto pt-1 border-t border-light-200 dark:border-dark-200">
              <div className="h-3 w-16 rounded glass-panel" />
              <div className="h-3 w-8 rounded glass-panel" />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full">
            <img
              src={`/weather-ico/${data.icon}.svg`}
              alt={data.condition}
              className="h-10 w-auto"
            />
            <span className="text-base font-semibold text-black dark:text-white">
              {data.temperature}°{data.temperatureUnit}
            </span>
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-2">
            <div className="flex flex-row items-center justify-between">
              <span className="text-sm font-semibold text-black dark:text-white">
                {data.location}
              </span>
              <span className="flex items-center text-xs text-black/60 dark:text-white/60 font-medium">
                <Wind className="w-3 h-3 mr-1" />
                {data.windSpeed} {data.windSpeedUnit}
              </span>
            </div>
            <span className="text-xs text-black/50 dark:text-white/50 italic">
              {data.condition}
            </span>
            <div className="flex flex-row justify-between w-full mt-auto pt-2 border-t border-light-200/50 dark:border-dark-200/50 text-xs text-black/50 dark:text-white/50 font-medium">
              <span>Humidity {data.humidity}%</span>
              <span className="font-semibold text-black/70 dark:text-white/70">
                Now
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default WeatherWidget;
