package com.manga.library.config;

import com.manga.library.service.ProviderConfigCache;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

@Configuration
public class RedisSubscriptionConfig {
  private static final Logger log = LoggerFactory.getLogger(RedisSubscriptionConfig.class);

  @Bean
  public MessageListener providerConfigMessageListener(ProviderConfigCache providerConfigCache) {
    return (Message message, byte[] pattern) -> {
      log.info("Received provider config update notification on Redis pub/sub channel.");
      providerConfigCache.reload();
    };
  }

  @Bean
  public RedisMessageListenerContainer redisMessageListenerContainer(
      RedisConnectionFactory connectionFactory,
      MessageListener providerConfigMessageListener) {
    RedisMessageListenerContainer container = new RedisMessageListenerContainer();
    container.setConnectionFactory(connectionFactory);
    container.addMessageListener(
        providerConfigMessageListener, new ChannelTopic("provider:config:updated"));
    return container;
  }
}
